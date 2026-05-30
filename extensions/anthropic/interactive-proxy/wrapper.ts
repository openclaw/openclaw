#!/usr/bin/env bun
/* oxlint-disable no-underscore-dangle -- `_reqId` / `_requestType` are
   intentional namespace markers on proxy-internal JSON events that flow
   between this wrapper and mitm-server, distinguishing proxy-added fields
   from upstream Anthropic API fields. */
/**
 * OpenClaw interactive proxy wrapper.
 *
 * Spawned per-turn by OpenClaw as the CLI command for the
 * claude-cli-interactive backend. Starts the MITM proxy, then runs claude
 * in interactive (subscription) mode with the prompt as a positional arg.
 * Every API SSE event is forwarded as a stream-json JSONL record, producing
 * output identical to `claude -p --output-format stream-json`.
 *
 * NODE_OPTIONS injects tty-spoof.cjs so Claude thinks stdin/stdout are
 * terminals and stays in interactive mode.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCerts } from "./cert-manager.js";
import { startMitmProxy } from "./mitm-server.js";

const TTY_SPOOF_PATH = fileURLToPath(new URL("./tty-spoof.cjs", import.meta.url));

function extractSessionId(args: string[]): string {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--session-id" || args[i] === "--resume") {
      return args[i + 1] ?? "";
    }
  }
  return "";
}

const DEBUG = process.env["OPENCLAW_INTERACTIVE_PROXY_DEBUG"] === "1";

function claudeSessionFilePath(sessionId: string): string | null {
  if (!sessionId) {return null;}
  const projectDir = process.cwd().replace(/[:\\/]/g, "-");
  return join(homedir(), ".claude", "projects", projectDir, `${sessionId}.jsonl`);
}

function getFileMtime(filePath: string): number {
  try { return statSync(filePath).mtimeMs; } catch { return 0; }
}

// Scan the tail of claude's session JSONL for the most recent error record.
// Used on the API-error exit path: when an HTTP non-2xx response arrives on
// /v1/messages, claude writes the error as a turn-end record (e.g.
// {type:"system",subtype:"error_during_execution",message:"..."} or
// content blocks with is_error:true) and waits for the next user input.
// We tail-scan the file to extract a human-readable error message for the
// synthetic result record the wrapper emits before killing claude.
function readSessionTailErrorMessage(sessionPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return null;
  }
  // Walk backwards through up to the last ~50 lines — that's plenty to
  // cover a single turn-end record plus any preceding context.
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 50; i--) {
    const line = lines[i]?.trim();
    if (!line) {continue;}
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.is_error === true) {
      const result = parsed.result;
      const message = parsed.message;
      if (typeof result === "string" && result.trim()) {return result.trim();}
      if (typeof message === "string" && message.trim()) {return message.trim();}
    }
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    if (subtype.startsWith("error")) {
      const message = parsed.message;
      const result = parsed.result;
      if (typeof message === "string" && message.trim()) {return message.trim();}
      if (typeof result === "string" && result.trim()) {return result.trim();}
    }
  }
  return null;
}

// Pull a short error message out of the proxy's api_error event body. Format
// matches Anthropic's API error envelopes: {type:"error",error:{type,message}}.
function extractApiErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const errorField = record.error;
    if (errorField && typeof errorField === "object") {
      const errRecord = errorField as Record<string, unknown>;
      const message = errRecord.message;
      const errType = errRecord.type;
      if (typeof message === "string" && message.trim()) {
        return typeof errType === "string" && errType.trim()
          ? `${errType.trim()}: ${message.trim()}`
          : message.trim();
      }
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
  }
  if (typeof body === "string" && body.trim()) {
    return `HTTP ${status}: ${body.slice(0, 200)}`;
  }
  return `HTTP ${status}`;
}

function dbg(...args: unknown[]): void {
  if (DEBUG) {process.stderr.write("[openclaw-proxy] " + args.join(" ") + "\n");}
}

// Flags that consume the immediately-following argv as a value. Used by the
// debug-arg redactor to identify which positions are flag values (NOT
// prompt content) so they pass through unchanged while the trailing
// positional prompt text gets summarised.
const VALUE_TAKING_CLAUDE_FLAGS = new Set([
  "--effort",
  "--setting-sources",
  "--permission-mode",
  "--resume",
  "--session-id",
  "--model",
  "--mcp-config",
  "--allowedTools",
  "--append-system-prompt-file",
  "--output-format",
  "--input-format",
  "--permission-prompt-tool",
  "--add-dir",
]);

const VALUELESS_CLAUDE_FLAGS = new Set([
  "-p",
  "--print",
  "--verbose",
  "--include-partial-messages",
  "--fork-session",
  "--strict-mcp-config",
  "--replay-user-messages",
]);

// Replace any non-flag, non-flag-value positional argv (i.e. the user prompt
// claude received via input:"arg") with a <prompt:N chars> summary so the
// debug stream — captured by OpenClaw's gateway.log when
// OPENCLAW_INTERACTIVE_PROXY_DEBUG=1 — never carries prompt text.
//
// Classify by membership in the known-flag sets, NOT by leading character:
// a user prompt can legitimately start with "-" or "--" (a CLI-quoted help
// string, a pasted markdown bullet list, etc.) and the previous shape
// would have logged those prompts verbatim. Anything that doesn't match a
// known flag is treated as a positional prompt and redacted.
function redactArgsForLog(args: string[]): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      out.push(arg);
      skipNext = false;
      continue;
    }
    if (VALUE_TAKING_CLAUDE_FLAGS.has(arg)) {
      out.push(arg);
      skipNext = true;
      continue;
    }
    if (VALUELESS_CLAUDE_FLAGS.has(arg)) {
      out.push(arg);
      continue;
    }
    out.push(`<prompt:${arg.length} chars>`);
  }
  return out;
}

// True iff `args` contains a positional that isn't a flag or a flag value —
// i.e. claudeArgs carries the user prompt the way input:"arg" expects.
// When OpenClaw spills the prompt to stdin (prompt > maxPromptArgChars),
// the positional is absent. The wrapper recovers from that state by
// reading the spilled prompt off its own stdin, writing it to a
// workspace .md file, and injecting a short positional that tells claude
// to read the file in full.
function claudeArgsContainPositional(args: readonly string[]): boolean {
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (VALUE_TAKING_CLAUDE_FLAGS.has(arg)) {
      skipNext = true;
      continue;
    }
    if (VALUELESS_CLAUDE_FLAGS.has(arg)) {continue;}
    return true;
  }
  return false;
}

// Response-content backup signature for a compaction-summary stream that
// somehow slipped past mitm-server's request-body tagging. claude-code's
// compaction output is a structured XML-ish document with these exact
// markers; matching all three keeps false-positives off real assistant
// replies that happen to mention one of the section names.
function isCompactionResponse(text: string): boolean {
  return (
    (text.includes("<analysis>") || text.includes("<summary>")) &&
    text.includes("Primary Request and Intent") &&
    text.includes("Pending Tasks")
  );
}

// Read process.stdin to completion as a UTF-8 string. Used to recover the
// prompt that OpenClaw spilled to our stdin (instead of argv) because it
// exceeded the per-platform argv cap.
function readStdinToString(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// File + dedicated dir holding the spill-recovered prompt content. The
// dir is per-run (random-suffixed) so --add-dir only exposes this run's
// own prompt to claude, never another concurrent run's. Both file and
// dir are unlinked when the wrapper exits so .openclaw-interactive-
// proxy/run-* directories don't accumulate. Registered on
// process.on("exit") as a final guard against crash/error paths that
// bypass the SIGTERM/SIGINT cleanup.
let overflowPromptFilePath: string | null = null;
let overflowPromptDirPath: string | null = null;
process.on("exit", () => {
  if (overflowPromptFilePath) {
    try { unlinkSync(overflowPromptFilePath); } catch {}
  }
  if (overflowPromptDirPath) {
    try { rmdirSync(overflowPromptDirPath); } catch {}
  }
});

async function main(): Promise<void> {
  let claudeArgs = process.argv.slice(2);

  dbg("starting, claude args:", redactArgsForLog(claudeArgs).join(" "));

  // Pre-flight: cli-backend-interactive sets maxPromptArgChars based on
  // the host's argv ceiling (30000 on Windows, 200000 on Unix) so OpenClaw
  // caps the argv-borne prompt at a size the OS will actually accept.
  // When the prompt exceeds that cap, OpenClaw's resolvePromptInput spills
  // it to the wrapper's stdin. Interactive claude has no stdin/file prompt
  // path of its own — TUI mode reads stdin as live keystrokes, not as the
  // initial turn prompt. To still deliver the full content while keeping
  // the same single-shot spawn pattern, write the spilled prompt to a
  // private OS tempdir file and inject a short positional argv telling
  // claude to read that file with its Read tool. The OS tempdir is chosen
  // over the workspace deliberately: even with cleanup hooks, SIGKILL /
  // host crash can leave a file behind, and the workspace is git-staged-
  // by-default territory where stray prompt content could be exposed.
  // OS tempdir is conventional for transient per-process data, user-
  // private on all supported platforms, and outside any tooling that
  // indexes the workspace.
  if (!claudeArgsContainPositional(claudeArgs)) {
    const cap = process.platform === "win32" ? 30000 : 200000;
    dbg(`prompt spilled to stdin (exceeded ${cap}-char argv cap); recovering via tempdir overflow file`);
    let spilledPrompt: string;
    try {
      spilledPrompt = await readStdinToString();
    } catch (e) {
      emitError(`failed to read spilled prompt from stdin: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!spilledPrompt) {
      emitError("prompt was spilled to stdin but stdin produced no content");
      return;
    }
    // Filename incorporates a 16-byte random suffix so the path is
    // unguessable to other local users — combined with the 0700/0600
    // permissions below, this protects prompt content on shared Unix
    // hosts where /tmp is world-traversable by default. Windows tempdir
    // is already user-private but the same path/mode flags are a no-op
    // belt-and-braces.
    const sessionIdForFile = extractSessionId(claudeArgs) || `pid-${process.pid}`;
    // Per-run dedicated subdirectory under the shared parent. The
    // randomSuffix is on the DIRECTORY name (not just the filename)
    // because --add-dir below extends claude's workspace scope to the
    // exact directory passed — sharing one parent directory across
    // runs would let a concurrent claude session enumerate other active
    // overflow prompts before cleanup. Per-run dir + 0700 mode + 0600
    // file gives each run an isolated, user-private slot.
    const parentDir = join(tmpdir(), "openclaw-interactive-proxy");
    const randomSuffix = randomBytes(16).toString("hex");
    const perRunDir = join(parentDir, `run-${randomSuffix}`);
    try {
      mkdirSync(parentDir, { recursive: true, mode: 0o700 });
      mkdirSync(perRunDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      emitError(
        `failed to create overflow tempdir: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    overflowPromptDirPath = perRunDir;
    overflowPromptFilePath = join(perRunDir, `prompt-overflow-${sessionIdForFile}.md`);
    try {
      writeFileSync(overflowPromptFilePath, spilledPrompt, { encoding: "utf8", mode: 0o600 });
    } catch (e) {
      emitError(
        `failed to write prompt overflow file: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    const shortPositional =
      `Your message exceeded the per-platform argv limit and was written to ` +
      `\`${overflowPromptFilePath}\` (an OpenClaw-owned file in the OS tempdir). ` +
      `Read that file in full using your Read tool, then respond to the ` +
      `complete content as if it had been typed inline.`;
    // Extend claude's workspace scope to ONLY the per-run subdir so its
    // Read tool can resolve the absolute path. Adding the parent would
    // expose every concurrent run's overflow file to this run; the
    // per-run subdir is the narrowest scope that still satisfies claude's
    // workspace-restriction rule.
    //
    // Auto-allow Read for THIS turn only — the standard interactive backend
    // ships `--allowedTools mcp__openclaw__*` which excludes Read, so the
    // shortPositional below ("Read that file in full…") would otherwise
    // stall on an unattended permission prompt for non-bypass operators.
    // Scope the grant to the EXACT spilled-prompt file via claude-cli's
    // gated tool specifier `Read(<path>)` rather than a bare `Read` — the
    // bare form would broaden the MCP-only allowlist to native Read of any
    // path on disk, whereas the parenthesized rule content limits the grant
    // to this one per-run file. Multiple `--allowedTools` flags concatenate
    // in claude-cli's argv parser, so this is additive — does NOT broaden the
    // surface for any OTHER turn (overflow recovery is per-turn argv mutation,
    // not a backend-config change). Closes ClawSweeper P2 on PR #81851.
    claudeArgs = [
      ...claudeArgs,
      "--allowedTools",
      `Read(${overflowPromptFilePath})`,
      "--add-dir",
      perRunDir,
      shortPositional,
    ];
    dbg(
      "spilled prompt recovered; chars:", spilledPrompt.length,
      "overflow-file:", overflowPromptFilePath,
      "add-dir:", perRunDir,
    );
  }

  let certs;
  try {
    certs = ensureCerts();
    dbg("certs ready:", certs.caPath);
  } catch (e) {
    process.stderr.write(
      `[openclaw-proxy] cert generation failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    emitError(`cert generation failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  let proxy;
  try {
    proxy = await startMitmProxy(certs);
  } catch (e) {
    process.stderr.write(
      `[openclaw-proxy] proxy start failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    emitError(`proxy start failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  process.stderr.write(
    `[openclaw-proxy] MITM proxy active on 127.0.0.1:${proxy.connectPort}` +
    ` — Anthropic API traffic intercepted locally to capture thinking_delta events\n`,
  );

  // Best-effort cleanup of the spill-recovery overflow file + its
  // per-run subdir. Called on every wrapper exit path (normal kill,
  // signal, error) so the file and its enclosing run-<random> dir
  // don't accumulate in the OS tempdir if the turn aborts before the
  // normal kill path runs.
  const cleanupOverflowFile = (): void => {
    if (overflowPromptFilePath) {
      try { unlinkSync(overflowPromptFilePath); } catch {}
      overflowPromptFilePath = null;
    }
    if (overflowPromptDirPath) {
      try { rmdirSync(overflowPromptDirPath); } catch {}
      overflowPromptDirPath = null;
    }
  };

  // Heartbeat ping timer — emits a `ping` stream_event every 30s of stdout
  // silence so the gateway (and ultimately Telegram's typing indicator)
  // knows the wrapper is still alive during long tool-execution gaps.
  // Without this, a Bash / WebFetch tool running for a minute makes the
  // gateway think the turn stalled and tear down the typing UI.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stopProxy = () => {
    proxy.stop().catch(() => {});
    cleanupOverflowFile();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  process.on("SIGTERM", () => { stopProxy(); process.exit(0); });
  process.on("SIGINT", () => { stopProxy(); process.exit(0); });

  const sessionId = extractSessionId(claudeArgs);

  // Last time anything was written to stdout — used by the heartbeat timer
  // (armed further below) to detect tool-execution silence (claude held
  // stdout closed for >30s). MUST be declared BEFORE the first emit() call
  // below: emit() writes to this variable, and a `let` in TDZ throws
  // ReferenceError when the function body fires.
  let lastEmitTime = Date.now();

  // Emit init record
  emit(JSON.stringify({ type: "init", session_id: sessionId }));

  // State tracking for result record
  let assistantText = "";
  let lastUsage: Record<string, unknown> = {};
  let currentStopReason = "";
  let turnActive = false;
  let intentionalKill = false;
  // True only on the synthetic-error exit path (api_error → emit is_error
  // result → kill). The non-live CLI runner's JSONL parser doesn't honour
  // is_error on its own — it relies on nonzero exit / timeout to detect
  // failure and trigger failover. Without this flag a 429 / billing / auth
  // failure would surface as a normal assistant reply containing the error
  // text instead of as a CLI-run failure.
  let intentionalKillIsError = false;
  // _reqId of the request whose stream is currently bound to the user's
  // turn. Set by the first non-auxiliary message_start the wrapper sees.
  // Subsequent events whose _reqId differs (concurrent aux requests
  // overlapping with the real turn) are dropped without touching turn
  // state. Reset on every new message_start that the wrapper does accept.
  let activeReqId = -1;

  function emit(jsonl: string): void {
    lastEmitTime = Date.now();
    process.stdout.write(jsonl + "\n");
  }

  function emitAndDrain(jsonl: string): Promise<void> {
    return new Promise((resolve) => {
      lastEmitTime = Date.now();
      const flushed = process.stdout.write(jsonl + "\n");
      if (flushed) {
        resolve();
      } else {
        process.stdout.once("drain", resolve);
      }
    });
  }

  // Arm the heartbeat AFTER emit/emitAndDrain are defined so the init
  // record above counts as the first emission. The timer fires every
  // HEARTBEAT_INTERVAL_MS and only writes a ping if no real emission
  // happened in that window — so a busy turn produces no extra noise.
  const HEARTBEAT_INTERVAL_MS = 30_000;
  heartbeatTimer = setInterval(() => {
    if (Date.now() - lastEmitTime >= HEARTBEAT_INTERVAL_MS) {
      process.stdout.write(
        JSON.stringify({ type: "stream_event", event: { type: "ping" } }) + "\n",
      );
      lastEmitTime = Date.now();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Spawn claude in interactive (subscription) mode.
  const claudeEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
    ),
    HTTPS_PROXY: `http://127.0.0.1:${proxy.connectPort}`,
    NODE_EXTRA_CA_CERTS: certs.caPath,
    NODE_OPTIONS: `--require "${TTY_SPOOF_PATH}"`,
  };

  const claudeBinary = process.env["OPENCLAW_INTERACTIVE_CLAUDE_BINARY"] || "claude";
  dbg("spawning claude binary:", claudeBinary);
  const claude = spawn(claudeBinary, claudeArgs, {
    env: claudeEnv,
    stdio: ["pipe", "ignore", "inherit"],
  });

  // Framework sends prompt via args (input:"arg"), stdin is just empty+close.
  // Forward data but do NOT forward the close — we need stdin open to send
  // /exit after the response so Claude saves the session before exiting.
  process.stdin.on("data", (chunk: Buffer) => {
    claude.stdin?.write(chunk);
  });

  claude.on("error", (err) => {
    process.stderr.write(`[openclaw-proxy] failed to spawn claude: ${err.message}\n`);
    stopProxy();
    process.exit(1);
  });

  claude.on("exit", (code, signal) => {
    stopProxy();
    dbg(
      "claude exited, code:", code,
      "signal:", signal,
      "intentional:", intentionalKill,
      "errorExit:", intentionalKillIsError,
    );
    if (intentionalKill) {
      // Success path exits 0; synthetic-error path exits 1 so the
      // non-live CLI runner treats the turn as failed and triggers
      // failover (it doesn't honour is_error in JSONL on its own).
      process.exitCode = intentionalKillIsError ? 1 : 0;
      process.stdin.destroy();
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });

  // Forward every API SSE event as a stream_event JSONL record
  // True once we've emitted any final `result` (success or error). Guards
  // against double-emitting if the API-error path and a stale SSE end_turn
  // race each other.
  let resultEmitted = false;

  // Shared exit path used by both the end_turn success branch and the
  // api_error branch: wait for claude to flush its session JSONL to disk,
  // then kill the child. Same mechanism for both because claude writes
  // turn-end records to the session JSONL on either path (successful
  // completion OR API error — claude doesn't self-exit on error, it ends
  // the turn and waits, so the session-write is our universal kill signal).
  const waitForSessionWriteThenKill = (): void => {
    const sessionPath = claudeSessionFilePath(sessionId);
    const baselineMtime = sessionPath ? getFileMtime(sessionPath) : 0;
    dbg("result flushed, waiting for session write before kill, path:", sessionPath);

    const doKill = (): void => {
      dbg("killing claude");
      try { claude.kill(); } catch {}
    };

    if (!sessionPath) { doKill(); return; }

    const poll = setInterval(() => {
      if (getFileMtime(sessionPath) > baselineMtime) {
        clearInterval(poll);
        dbg("session file updated, killing claude");
        doKill();
      }
    }, 150);
    setTimeout(() => { clearInterval(poll); doKill(); }, 15000);
  };

  proxy.onEvent((evt) => {
    const eventType = evt.type as string;
    // Synthetic event emitted by mitm-server when /v1/messages returns a
    // non-SSE 4xx/5xx (rate limit, billing, auth, overloaded, etc.). It
    // carries no _reqId / _requestType tags — short-circuit
    // before the tag-extraction shape below.
    if (eventType === "api_error") {
      if (resultEmitted || intentionalKill) {return;}
      resultEmitted = true;
      turnActive = false;
      const status = typeof evt.status === "number" ? evt.status : 0;
      const message = extractApiErrorMessage(evt.body, status);
      // Best-effort: claude may already have flushed the failure to the
      // session JSONL by the time we read; otherwise fall back to the
      // proxy-extracted message. Either way the synthetic result carries
      // something useful for OpenClaw / Telegram to surface.
      const sessionPath = claudeSessionFilePath(sessionId);
      const sessionMessage = sessionPath ? readSessionTailErrorMessage(sessionPath) : null;
      const errorResult: Record<string, unknown> = {
        type: "result",
        subtype: "error_during_execution",
        session_id: sessionId,
        result: sessionMessage ?? message,
        is_error: true,
      };
      dbg(
        "api_error event, status:", status,
        "session-message:", sessionMessage ? "present" : "absent",
        "exiting cleanly",
      );
      intentionalKill = true;
      intentionalKillIsError = true;
      emitAndDrain(JSON.stringify(errorResult)).then(() => waitForSessionWriteThenKill());
      return;
    }

    // Pull mitm-server's per-request classification off the event and
    // strip the internal tags before serializing, so downstream JSONL
    // carries an unmodified Anthropic SSE event shape (no _reqId /
    // _requestType leak into OpenClaw / Telegram). _requestType is the
    // primary routing key for the four-way switch below.
    const reqId = typeof evt._reqId === "number" ? evt._reqId : 0;
    const requestType = (typeof evt._requestType === "string" ? evt._requestType : "normal") as
      | "normal"
      | "compaction"
      | "tool_followup"
      | "auxiliary";
    delete evt._reqId;
    delete evt._requestType;
    const line = JSON.stringify({ type: "stream_event", event: evt });

    // Auxiliary side-requests (Haiku title-gen, classifiers, skill-search,
    // etc.) — drop the entire stream. The wrapper must never surface a
    // one-line `{"title":"..."}` response as the user's reply.
    if (requestType === "auxiliary") {
      return;
    }

    if (eventType === "message_start") {
      // Bind this stream as the active turn. Per-stream state resets;
      // assistantText is reset because each tracked stream produces its
      // own reply (tool_followup loops are handled by individual streams
      // chained back-to-back, not by cross-stream text accumulation in
      // the wrapper).
      activeReqId = reqId;
      turnActive = true;
      assistantText = "";
      currentStopReason = "";
      lastUsage = {};
      dbg("turn start reqId=", reqId, "type=", requestType);
      // Compaction streams: suppress message_start — downstream sees only
      // the rewritten thinking_delta content for this stream.
      if (requestType === "compaction") {return;}
      emit(line);
      return;
    }

    // Drop events from requests we're not tracking — a concurrent stream
    // bound elsewhere, or stale tail events trailing in.
    if (reqId !== activeReqId) {
      return;
    }

    // Compaction: rewrite text deltas as thinking_delta so the summary
    // surfaces as reasoning; drop everything else for the stream. The
    // next non-compaction stream's message_start will rebind activeReqId.
    if (requestType === "compaction") {
      if (eventType === "content_block_delta") {
        const d = evt.delta as Record<string, unknown> | undefined;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          const thinkingEvt = {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: (evt as Record<string, unknown>).index ?? 0,
              delta: { type: "thinking_delta", thinking: d.text },
            },
          };
          emit(JSON.stringify(thinkingEvt));
        }
        return;
      }
      if (eventType === "message_stop") {
        turnActive = false;
        dbg("compaction stream message_stop reqId=", reqId, "— awaiting real turn");
      }
      return;
    }

    // ── Normal + tool_followup: emit events, result on end_turn ──
    // Both are user-facing — tool_followup means we're mid-loop, but the
    // final answer can come from either (model responds with end_turn
    // after processing tool results, and that response classifies as
    // tool_followup because the request body still has the tool_result
    // as the last message).
    if (!turnActive) {return;}

    if (eventType === "content_block_delta") {
      const d = evt.delta as Record<string, unknown> | undefined;
      if (d?.type === "text_delta" && typeof d.text === "string") {
        assistantText += d.text;
      }
    }

    if (eventType === "message_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === "string") {
        currentStopReason = delta.stop_reason;
      }
      if (evt.usage) {
        lastUsage = evt.usage as Record<string, unknown>;
      }
    }

    emit(line);

    if (eventType === "message_stop" && turnActive) {
      turnActive = false;
      if (currentStopReason !== "end_turn") {
        // tool_use / other non-terminal stop on a "normal" stream is
        // theoretically possible when claude opens with a tool call on
        // the very first request — leave turnActive=false and let the
        // follow-up classify into tool_followup on the next message_start.
        return;
      }
      if (resultEmitted || intentionalKill) {return;}

      // Belt-and-braces: if a compaction-shaped response somehow slipped
      // past the request-level classifier (unseen prompt wording,
      // structural drift), the response content still carries the
      // distinctive `<analysis>` + Primary-Request-and-Intent +
      // Pending-Tasks fingerprint. Discard it and wait for the real
      // user turn rather than emit it as the reply.
      if (isCompactionResponse(assistantText)) {
        dbg(
          "compaction signature in response (untagged); discarding, len:",
          assistantText.length,
        );
        assistantText = "";
        return;
      }
      resultEmitted = true;
      const result: Record<string, unknown> = {
        type: "result",
        session_id: sessionId,
        result: assistantText,
        is_error: false,
        stop_reason: currentStopReason,
      };
      if (Object.keys(lastUsage).length > 0) {result.usage = lastUsage;}
      dbg("emitting result, text len:", assistantText.length);
      assistantText = "";
      intentionalKill = true;
      emitAndDrain(JSON.stringify(result)).then(() => waitForSessionWriteThenKill());
    }
  });
}

function emitError(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "error",
      result: "",
      is_error: true,
      error: `claude-cli-interactive proxy unavailable (${reason})`,
    }) + "\n",
  );
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`[openclaw-proxy] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
