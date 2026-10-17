import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, readFile, readlink, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { writeGatewayRestartIntentSync } from "openclaw/plugin-sdk/qa-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { closeQaHttpServer } from "./bus-server.js";
import { createQaGatewayChild, type QaGatewayChild } from "./gateway-child.js";
import { QA_SUBAGENT_TERMINAL_MARKERS } from "./providers/mock-openai/mock-openai-contracts.js";
import { resolveMockSubagentTurn } from "./providers/mock-openai/mock-openai-input.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import {
  readPrivateCompletionRows as rows,
  readPrivateCompletionNativeRuns,
} from "./subagent-private-completion-package.test-support.js";

const exec = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const candidateTarball = process.env.OPENCLAW_CURRENT_PACKAGE_TGZ;
const releasedVersion = "2026.9.4";
const privateMarker = /QA-PARENT-PRIVATE-CHILD[12]|qa-private-result\.png/u;
const ordinaryMarker = QA_SUBAGENT_TERMINAL_MARKERS.silent;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALklEQVR4nO3OoQEAAAyDsP7/9HYGJgJNdtuVDQAAAAAAACAHxH8AAAAAAACAHvBX0fhq85dN7QAAAABJRU5ErkJggg==";
const readJson = async (file: string) => record(JSON.parse(await readFile(file, "utf8")));
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

async function holdProviderRequests(baseUrl: string) {
  let armed = false;
  let childHeld = false;
  let mainHeld = false;
  const child = createDeferred<void>();
  const main = createDeferred<void>();
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString();
      const input: unknown = body ? JSON.parse(body).input : undefined;
      const currentTurn = resolveMockSubagentTurn(
        Array.isArray(input)
          ? input
          : typeof input === "string"
            ? [{ role: "user", content: input }]
            : [],
      );
      const prompt = currentTurn?.text ?? "";
      const closed = new Promise<void>((resolve) => {
        res.once("close", resolve);
      });
      if (armed && currentTurn?.kind === "worker" && currentTurn.privateWorker === "first") {
        childHeld = true;
        await Promise.race([child.promise, closed]);
      } else if (armed && prompt.includes("QA PACKAGE MAIN HOLD")) {
        mainHeld = true;
        await Promise.race([main.promise, closed]);
      }
      if (res.destroyed) {
        return;
      }
      const response = await fetch(`${baseUrl}${req.url}`, {
        method: req.method,
        headers: {
          "content-type": "application/json",
          ...(typeof req.headers.session_id === "string"
            ? { session_id: req.headers.session_id }
            : {}),
          ...(typeof req.headers["x-session-affinity"] === "string"
            ? { "x-session-affinity": req.headers["x-session-affinity"] }
            : {}),
        },
        ...(req.method === "POST" ? { body } : {}),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "application/json",
      });
      res.end(bytes);
    })().catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("provider hold has no port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    arm: () => {
      armed = true;
    },
    childHeld: () => childHeld,
    mainHeld: () => mainHeld,
    releaseChild: () => child.resolve(),
    release: () => {
      armed = false;
      child.resolve();
      main.resolve();
    },
    stop: () => closeQaHttpServer(server),
  };
}

function requiredSqlValue(row: Record<string, SQLInputValue>, key: string): SQLInputValue {
  const value = row[key];
  if (value === undefined) {
    throw new Error(`missing required SQLite field: ${key}`);
  }
  return value;
}

function requiredSqlText(row: Record<string, SQLInputValue>, key: string): string {
  const value = requiredSqlValue(row, key);
  if (typeof value !== "string") {
    throw new Error(`expected SQLite text field: ${key}`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  expect(isRecord(value)).toBe(true);
  return value as Record<string, unknown>;
}

async function observeChat(gateway: QaGatewayChild, events: unknown[]) {
  const ready = createDeferred<void>();
  const timer = setTimeout(
    () => ready.reject(new Error("package observer connection timed out")),
    30_000,
  );
  let client: GatewayClient | undefined;
  try {
    client = new GatewayClient({
      url: gateway.wsUrl,
      token: gateway.token,
      deviceIdentity: null,
      clientName: "gateway-client",
      mode: "backend",
      scopes: ["operator.admin"],
      onHelloOk: () => ready.resolve(),
      onConnectError: (error) => ready.reject(error),
      onEvent: (event) => {
        if (event.event === "chat") {
          events.push(structuredClone(event.payload));
        }
      },
    });
    client.start();
    await ready.promise;
    return client;
  } catch (error) {
    await client?.stopAndWait();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Package acceptance supplies one attested candidate; ordinary test runs do not download releases.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(!candidateTarball)(
  "preserves ordinary state through Doctor upgrade and backup rollback without publishing private replies",
  async () => {
    const prefix = tempDirs.make("openclaw-private-package-");
    const installedRoot = path.join(prefix, "lib", "node_modules", "openclaw");
    const cli = path.join(installedRoot, "openclaw.mjs");
    const evidenceDir = path.join(repoRoot, ".crabbox", "captures", "issue-27445-package");
    await mkdir(evidenceDir, { recursive: true });
    const candidateSha256 = sha256(await readFile(candidateTarball!));
    const sourceTree = (
      await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoRoot })
    ).stdout.trim();
    const candidateManifest = await readJson(path.join(repoRoot, "package.json"));
    const candidateVersion = candidateManifest.version;
    const candidateSchemaVersions = record(record(candidateManifest.openclaw).schemaVersions);
    const candidateAgentSchemaVersion = candidateSchemaVersions.agent;
    const candidateSharedSchemaVersion = candidateSchemaVersions.state;
    if (
      typeof candidateVersion !== "string" ||
      typeof candidateAgentSchemaVersion !== "number" ||
      !Number.isSafeInteger(candidateAgentSchemaVersion) ||
      typeof candidateSharedSchemaVersion !== "number" ||
      !Number.isSafeInteger(candidateSharedSchemaVersion)
    ) {
      throw new Error(
        "Candidate package must declare its version and agent/shared schema versions",
      );
    }
    const published = JSON.parse(
      (await exec("npm", ["view", `openclaw@${releasedVersion}`, "version", "dist", "--json"]))
        .stdout,
    ) as { version: string; dist: { integrity: string; tarball: string } };
    expect(published.version).toBe(releasedVersion);
    expect(published.dist.integrity).toMatch(/^sha512-/u);
    const phases: Record<string, unknown>[] = [];
    let packageIdentity: { packageVersion: unknown; cliVersion: string };
    const phase = (name: string, evidence: Record<string, unknown> = {}) =>
      phases.push({ phase: name, ...packageIdentity, ...evidence });
    const events: unknown[] = [];
    const mock = await startQaMockOpenAiServer();
    const heldProvider = await holdProviderRequests(mock.baseUrl);
    let owner: ReturnType<typeof createQaGatewayChild> | undefined;
    let observer: GatewayClient | undefined;
    let gateway: QaGatewayChild;
    let agentDb: string;
    let stateDb: string;
    let passed = false;

    const agentRows = (sql: string, ...args: SQLInputValue[]) => rows(agentDb, sql, ...args);
    const stateRows = (sql: string, ...args: SQLInputValue[]) => rows(stateDb, sql, ...args);
    function mutateRegistry(sql: string, ...args: SQLInputValue[]) {
      const db = new DatabaseSync(stateDb);
      try {
        db.prepare(sql).run(...args);
      } finally {
        db.close();
      }
    }
    const runCompletions = (runId: SQLInputValue, columns = "*", suffix = "") =>
      agentRows(
        `SELECT ${columns} FROM session_input_completions WHERE run_id = ?${suffix}`,
        runId,
      );
    const debug = async (endpoint: string) =>
      await (await fetch(`${mock.baseUrl}/debug/${endpoint}`)).json();
    const registryRows = (runId: SQLInputValue) =>
      rows(stateDb, "SELECT * FROM subagent_runs WHERE run_id = ?", runId);
    const pendingInputs = (sessionKey: string) =>
      agentRows("SELECT * FROM session_pending_inputs WHERE session_key = ?", sessionKey);
    const completionRows = (sessionKey: string) =>
      agentRows(
        "SELECT * FROM session_input_completions WHERE session_key = ? ORDER BY run_id",
        sessionKey,
      );
    const sessionRow = (key: string) =>
      agentRows("SELECT current_session_id FROM session_nodes WHERE session_key = ?", key)[0];
    const transcript = (sessionId: string) =>
      agentRows(
        "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
        sessionId,
      );
    const waitForReply = (
      since: number,
      expected: { sessionKey: unknown; runId?: unknown; state?: string },
      marker: string | RegExp,
    ) =>
      waitForQaTransportCondition(
        () =>
          events.slice(since).some((event) => {
            if (
              !isRecord(event) ||
              !Object.entries(expected).every(([key, value]) => event[key] === value)
            ) {
              return false;
            }
            const text = JSON.stringify(replies([event.message]));
            return typeof marker === "string" ? text.includes(marker) : marker.test(text);
          }) || undefined,
        30_000,
        100,
      );
    const installedJson = async (args: string[]) =>
      record(JSON.parse((await runInstalled(args)).stdout));

    async function install(spec: string) {
      await exec("npm", ["install", "-g", "--prefix", prefix, spec, "--no-fund", "--no-audit"], {
        timeout: 300_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const manifest = await readJson(path.join(installedRoot, "package.json"));
      expect(manifest.version).toBeTypeOf("string");
      expect(manifest.version).toBe(
        spec === `openclaw@${releasedVersion}` ? releasedVersion : candidateVersion,
      );
      const version = (
        await exec(process.execPath, [cli, "--version"], { cwd: prefix })
      ).stdout.trim();
      expect(version).toContain(String(manifest.version));
      packageIdentity = { packageVersion: manifest.version, cliVersion: version };
      return packageIdentity;
    }

    async function start() {
      owner = createQaGatewayChild();
      const started = await owner.start({
        repoRoot,
        command: {
          executablePath: process.execPath,
          argsPrefix: [cli],
          cwd: prefix,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        providerBaseUrl: `${heldProvider.baseUrl}/v1`,
        mockSessionObserverUrl: mock.sessionObserverUrl,
        forcedRuntime: "openclaw",
        transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        mutateConfig: (cfg) => ({
          ...cfg,
          agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, maxConcurrent: 1 } },
          tools: { ...cfg.tools, deny: [...(cfg.tools?.deny ?? []), "message"] },
          plugins: {
            ...cfg.plugins,
            allow: cfg.plugins?.allow?.filter((id) => id !== "qa-lab" && id !== "memory-core"),
            entries: Object.fromEntries(
              Object.entries(cfg.plugins?.entries ?? {}).filter(
                ([id]) => id !== "qa-lab" && id !== "memory-core",
              ),
            ),
            slots: { ...cfg.plugins?.slots, memory: "none" },
          },
          memory: { ...cfg.memory, search: { ...cfg.memory?.search, enabled: false } },
        }),
      });
      expect(started.runtimeEnv.OPENCLAW_DEV_SOURCE_ROOT).toBeUndefined();
      expect(started.runtimeEnv.OPENCLAW_BUNDLED_PLUGINS_DIR).toBeUndefined();
      observer = await observeChat(started, events);
      return {
        gateway: started,
        agentDb: path.join(
          started.runtimeEnv.OPENCLAW_STATE_DIR!,
          "agents",
          "qa",
          "agent",
          "openclaw-agent.sqlite",
        ),
        stateDb: path.join(started.runtimeEnv.OPENCLAW_STATE_DIR!, "state", "openclaw.sqlite"),
      };
    }

    const nativeRuns = (key: string) => readPrivateCompletionNativeRuns(stateDb, key);
    const delivered = (task: ReturnType<typeof nativeRuns>[number]) =>
      task.status === "completed" && task.deliveryStatus === "delivered";
    const waitForChildren = (key: string, settle = false) =>
      waitForQaTransportCondition(
        async () => {
          if (settle) {
            await mock.terminalRequesters.settle(gateway);
          }
          const children = nativeRuns(key);
          return children.length === 2 && children.every(delivered) ? children : undefined;
        },
        120_000,
        100,
      );

    async function send(sessionKey: string, message: string) {
      await gateway.call("sessions.create", { key: sessionKey });
      const accepted = record(
        await gateway.call("chat.send", { sessionKey, message, idempotencyKey: randomUUID() }),
      );
      expect(accepted.runId).toBeTruthy();
      return accepted;
    }

    async function history(sessionKey: string) {
      return await gateway.call("chat.history", {
        sessionKey,
        agentId: "qa",
        limit: 100,
        maxChars: 100_000,
      });
    }

    // Tool arguments remain normal operator-visible transcript context. This
    // checks reply text/media, not confidentiality from the parent-session UI.
    function replies(messages: unknown[]) {
      return messages
        .filter(isRecord)
        .filter((message) => message.role === "assistant")
        .map((message) => ({
          text: message.text,
          content: Array.isArray(message.content)
            ? message.content.filter(
                (block) =>
                  !isRecord(block) ||
                  !["toolCall", "toolcall", "tool_use", "thinking", "reasoning"].includes(
                    String(block.type),
                  ),
              )
            : message.content,
          attachments: message.attachments,
          mediaUrl: message.mediaUrl,
          mediaUrls: message.mediaUrls,
        }));
    }

    function assertPrivateReplies(messages: unknown[]) {
      const rendered = replies(messages);
      expect(JSON.stringify(rendered)).not.toMatch(privateMarker);
      expect(JSON.stringify(rendered)).not.toMatch(/\bNO_REPLY\b/u);
      for (const reply of rendered) {
        if (Array.isArray(reply.content)) {
          expect(
            reply.content.every(
              (block) => isRecord(block) && ["text", "output_text"].includes(String(block.type)),
            ),
          ).toBe(true);
        }
        expect(reply.attachments ?? []).toEqual([]);
        expect(reply.mediaUrl).toBeUndefined();
        expect(reply.mediaUrls ?? []).toEqual([]);
      }
    }

    async function assertPrivateHistory(sessionKey: string) {
      const page = record(await history(sessionKey));
      expect(page.pendingInputs).toEqual({ items: [], total: 0 });
      expect(Array.isArray(page.messages)).toBe(true);
      const messages = page.messages as unknown[];
      expect(
        JSON.stringify(messages.filter((message) => isRecord(message) && message.role === "user")),
      ).not.toMatch(privateMarker);
      assertPrivateReplies(messages);
    }

    function capturedReplies(sessionKey: string, since = 0) {
      // This admin observer also receives child-session transcript events. The
      // private handoff controls publication to the parent, not child inspection.
      return events
        .slice(since)
        .filter(isRecord)
        .filter((event) => event.sessionKey === sessionKey)
        .map((event) => event.message);
    }

    async function privateChain(sessionKey: string) {
      await writeFile(path.join(gateway.workspaceDir, "qa-private-result.png"), png, "base64");
      const eventCursor = events.length;
      const kickoff = await send(
        sessionKey,
        "Subagent terminal reply QA check: private. Review the first child internally, use its result to start a second child, and remain silent after each completion.",
      );
      const children = await waitForChildren(sessionKey, true);
      const receipts = completionRows(sessionKey);
      const successfulReceipts = receipts.filter((receipt) => receipt.succeeded === 1);
      expect(successfulReceipts.length).toBeGreaterThanOrEqual(2);
      expect(pendingInputs(sessionKey)).toEqual([]);
      const stored = stateRows(
        "SELECT payload_json FROM subagent_runs WHERE requester_session_key = ? ORDER BY run_id",
        sessionKey,
      );
      expect(stored.length).toBeGreaterThanOrEqual(2);
      expect(
        stored.every((row) => record(JSON.parse(String(row.payload_json))).parentCompletion),
      ).toBe(true);
      await assertPrivateHistory(sessionKey);
      await waitForReply(
        eventCursor,
        { sessionKey, runId: kickoff.runId, state: "final" },
        "Worker started.",
      );
      for (const child of children) {
        expect([typeof child.childSessionKey, typeof child.runId]).toEqual(["string", "string"]);
        await waitForReply(
          eventCursor,
          { sessionKey: child.childSessionKey, runId: child.runId, state: "final" },
          privateMarker,
        );
      }
      assertPrivateReplies(capturedReplies(sessionKey, eventCursor));
      return { sessionKey, children, receipts };
    }

    async function ordinaryChild(sessionKey: string) {
      const eventCursor = events.length;
      await send(
        sessionKey,
        "Subagent terminal reply QA check: silent. Spawn one native worker, then report its completion to this conversation. Do not use ACP.",
      );
      const child = await waitForQaTransportCondition(
        async () => {
          await mock.terminalRequesters.settle(gateway);
          const currentChild = nativeRuns(sessionKey).find(
            (task) => task.title === "qa-terminal-silent",
          );
          return currentChild && delivered(currentChild) ? currentChild : undefined;
        },
        120_000,
        100,
      );
      await waitForQaTransportCondition(
        async () =>
          JSON.stringify(replies(record(await history(sessionKey)).messages as unknown[])).includes(
            ordinaryMarker,
          ) || undefined,
        30_000,
        100,
      );
      // A positive live event qualifies the observation interval after startup.
      await waitForReply(eventCursor, { sessionKey }, ordinaryMarker);
      return child;
    }

    async function runInstalled(args: string[]) {
      return await exec(process.execPath, [cli, ...args], {
        cwd: prefix,
        env: gateway.runtimeEnv,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    }

    function assertSchema(agentVersion: number, sharedVersion: number) {
      expect(rows(agentDb, "PRAGMA user_version")[0]?.user_version).toBe(agentVersion);
      expect(rows(agentDb, "SELECT schema_version FROM schema_meta")[0]?.schema_version).toBe(
        agentVersion,
      );
      expect(rows(stateDb, "PRAGMA user_version")[0]?.user_version).toBe(sharedVersion);
    }

    async function restartState(
      mutate: (context: { stateDir: string; configPath: string }) => Promise<void>,
      interruptedInput?: { input_id: SQLInputValue; run_id: SQLInputValue },
    ) {
      await observer?.stopAndWait();
      observer = undefined;
      const originalState = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
      if (interruptedInput) {
        const info = record(await gateway.call("system.info", {}));
        expect(info.pid).toBe(gateway.pid);
        expect(
          writeGatewayRestartIntentSync({
            env: gateway.runtimeEnv,
            targetPid: Number(info.pid),
            reason: "qa-package-version-cycle",
            intent: { force: true, waitMs: 0 },
          }),
        ).toBe(true);
      }
      await gateway.restartAfterStateMutation(async (context) => {
        expect(context.stateDir).toBe(originalState);
        if (interruptedInput) {
          const stopped = agentRows(
            "SELECT * FROM session_pending_inputs WHERE input_id = ?",
            interruptedInput.input_id,
          )[0];
          expect(stopped).toMatchObject({ ...interruptedInput, state: "interrupted" });
          expect(runCompletions(interruptedInput.run_id, "*", " AND succeeded = 1")).toEqual([]);
          expect(gateway.logs()).toMatch(/restart shutdown|external-restart/u);
          heldProvider.release();
        }
        await mutate(context);
      });
      expect(gateway.runtimeEnv.OPENCLAW_STATE_DIR).toBe(originalState);
      observer = await observeChat(gateway, events);
    }

    try {
      await install(candidateTarball!);
      ({ gateway, agentDb, stateDb } = await start());
      const fresh = await privateChain("agent:qa:package-fresh-private");
      phase("fresh-candidate", {
        privateChildren: fresh.children.length,
        processingReceipts: fresh.receipts.length,
      });
      await observer?.stopAndWait();
      observer = undefined;
      expect(
        (await owner!.stop({ preserveToDir: path.join(evidenceDir, "fresh") })).errors,
      ).toEqual([]);
      owner = undefined;

      await install(`openclaw@${releasedVersion}`);
      ({ gateway, agentDb, stateDb } = await start());
      const ordinarySession = "agent:qa:package-released-ordinary";
      const ordinary = await ordinaryChild(ordinarySession);
      const originalSession = sessionRow(ordinarySession);
      if (!originalSession || typeof originalSession.current_session_id !== "string") {
        throw new Error("released ordinary session has no current session ID");
      }
      const originalSessionId = originalSession.current_session_id;
      const originalTranscript = transcript(originalSessionId);
      expect(originalTranscript.length).toBeGreaterThan(0);
      function assertOriginalOrdinaryState() {
        expect(sessionRow(ordinarySession)).toEqual(originalSession);
        expect(transcript(originalSessionId)).toEqual(originalTranscript);
        expect(
          nativeRuns(ordinarySession).some(
            (task) => task.childSessionKey === ordinary.childSessionKey,
          ),
        ).toBe(true);
      }
      phase("released-created-state", {
        ordinaryTaskId: ordinary.childSessionKey,
        sessionId: originalSessionId,
      });

      assertSchema(19, 17);
      const backupPath = path.join(prefix, "pre-upgrade.tar.gz");
      await restartState(async () => {
        // QA's source mount is outside the backup assets and is unused by this
        // installed-package proof. Remove only that exact fixture-owned link.
        const repoLink = path.join(gateway.workspaceDir, "repo");
        expect((await lstat(repoLink)).isSymbolicLink()).toBe(true);
        expect(await readlink(repoLink)).toBe(repoRoot);
        await unlink(repoLink);
        const backup = await installedJson([
          "backup",
          "create",
          "--output",
          backupPath,
          "--verify",
          "--json",
        ]);
        expect(backup.verified).toBe(true);
        const verified = await installedJson(["backup", "verify", backupPath, "--json"]);
        expect(verified.ok).toBe(true);
        phase("released-verified-backup", {
          archiveSha256: sha256(await readFile(backupPath)),
          schemaVersion: 19,
        });
        await install(candidateTarball!);
        // The target Doctor owns its declared schema upgrade; a released
        // schema-19 build cannot reopen that upgraded database.
        await runInstalled(["doctor", "--fix", "--non-interactive"]);
        assertSchema(candidateAgentSchemaVersion, candidateSharedSchemaVersion);
      });
      assertOriginalOrdinaryState();
      const privateState = await privateChain("agent:qa:package-upgraded-private");
      phase("candidate-doctor-upgrade", {
        privateChildren: privateState.children.length,
        processingReceipts: privateState.receipts.length,
      });

      // Subagent execution has its own lane. Hold unrelated Main work so private
      // admission is durable while its parent has not begun consuming the result.
      const pendingSession = "agent:qa:package-pending-private";
      heldProvider.arm();
      const kickoff = await send(
        pendingSession,
        "Subagent terminal reply QA check: private. Review the first child internally and remain silent.",
      );
      await waitForQaTransportCondition(() => heldProvider.childHeld() || undefined, 30_000, 50);
      await waitForQaTransportCondition(
        () =>
          events.some(
            (event) => isRecord(event) && event.runId === kickoff.runId && event.state === "final",
          ) || undefined,
        30_000,
        50,
      );
      await send(
        "agent:qa:package-main-blocker",
        "QA PACKAGE MAIN HOLD. repeated request queued reply gateway qa check",
      );
      await waitForQaTransportCondition(() => heldProvider.mainHeld() || undefined, 30_000, 50);
      heldProvider.releaseChild();
      const pendingInput = await waitForQaTransportCondition(
        async () => {
          await mock.terminalRequesters.settle(gateway);
          const pendingRow = agentRows(
            "SELECT * FROM session_pending_inputs WHERE session_key = ? AND state = 'queued'",
            pendingSession,
          ).find((row) =>
            requiredSqlText(row, "message_json").includes("QA-PARENT-PRIVATE-CHILD1-"),
          );
          return pendingRow
            ? {
                ...pendingRow,
                input_id: requiredSqlText(pendingRow, "input_id"),
                run_id: requiredSqlText(pendingRow, "run_id"),
                session_id: requiredSqlText(pendingRow, "session_id"),
                message_json: requiredSqlText(pendingRow, "message_json"),
                consumed_event_id: requiredSqlValue(pendingRow, "consumed_event_id"),
                state: requiredSqlText(pendingRow, "state"),
              }
            : undefined;
        },
        60_000,
        50,
      );
      expect(pendingInput.consumed_event_id).toBeNull();
      expect(record(JSON.parse(pendingInput.message_json)).display).toBe(false);
      const pendingNonce = /QA-PARENT-PRIVATE-CHILD1-[A-F0-9]{32}/u.exec(
        pendingInput.message_json,
      )?.[0];
      expect(pendingNonce).toBeTruthy();
      expect(JSON.stringify(transcript(pendingInput.session_id))).not.toContain(pendingNonce);
      expect(runCompletions(pendingInput.run_id)).toEqual([]);
      phase("candidate-queued-private-input", {
        sessionId: pendingInput.session_id,
        runId: pendingInput.run_id,
        state: pendingInput.state,
      });

      const pendingChildKey = nativeRuns(pendingSession)[0]?.childSessionKey;
      if (typeof pendingChildKey !== "string") {
        throw new Error("queued private task has no child session key");
      }
      const captured = stateRows(
        "SELECT * FROM subagent_runs WHERE child_session_key = ?",
        pendingChildKey,
      )[0];
      if (!captured) {
        throw new Error("queued private task has no registry envelope");
      }
      const capturedRow = {
        ...captured,
        run_id: requiredSqlText(captured, "run_id"),
        child_session_key: requiredSqlText(captured, "child_session_key"),
        controller_session_key: requiredSqlValue(captured, "controller_session_key"),
        requester_session_key: requiredSqlText(captured, "requester_session_key"),
        created_at: requiredSqlValue(captured, "created_at"),
        payload_json: requiredSqlText(captured, "payload_json"),
      };
      const privatePayload = record(record(JSON.parse(capturedRow.payload_json)).parentCompletion);
      expect(record(privatePayload.execution).status).toBe("terminal");
      expect(record(privatePayload.completion).required).toBe(true);
      expect(["pending", "in_progress"]).toContain(record(privatePayload.delivery).status);
      expect(JSON.stringify(privatePayload.completion)).toMatch(privateMarker);
      const settledNonce = /QA-PARENT-PRIVATE-CHILD1-[A-F0-9]{32}/u.exec(
        JSON.stringify(
          await history(
            privateState.children.find((child) => child.title === "qa-terminal-private-first")!
              .childSessionKey as string,
          ),
        ),
      )?.[0];
      expect(settledNonce).toBeTruthy();
      const restartCursor = record(await debug("request-cursor")).cursor;
      await restartState(async () => {}, pendingInput);
      const resumedChildren = await waitForChildren(pendingSession);
      expect(pendingInputs(pendingSession)).toEqual([]);
      expect(runCompletions(pendingInput.run_id, "succeeded")).toEqual([{ succeeded: 1 }]);
      expect(completionRows(privateState.sessionKey)).toEqual(privateState.receipts);
      expect(nativeRuns(privateState.sessionKey).map((task) => task.childSessionKey)).toEqual(
        privateState.children.map((task) => task.childSessionKey),
      );
      const restartRequests = await debug(`requests?after=${String(restartCursor)}`);
      expect(JSON.stringify(restartRequests)).not.toContain(settledNonce);
      await assertPrivateHistory(privateState.sessionKey);
      await assertPrivateHistory(pendingSession);
      assertPrivateReplies(capturedReplies(privateState.sessionKey));
      assertPrivateReplies(capturedReplies(pendingSession));
      phase("candidate-restart-durability", {
        resumedChildren: resumedChildren.length,
      });

      await restartState(async ({ stateDir, configPath }) => {
        await install(`openclaw@${releasedVersion}`);
        const target = path.join(prefix, "restored-backup");
        const restored = await installedJson([
          "backup",
          "restore",
          backupPath,
          "--target",
          target,
          "--json",
        ]);
        const manifest = await readJson(
          path.join(target, String(restored.archiveRoot), "manifest.json"),
        );
        expect(Array.isArray(manifest.assets)).toBe(true);
        const assets = (manifest.assets as unknown[]).map(record);
        expect(assets.filter((asset) => asset.kind === "state")).toHaveLength(1);
        expect(assets.filter((asset) => asset.kind === "config")).toHaveLength(1);
        const destinations = new Set([stateDir, configPath, gateway.workspaceDir]);
        for (const [index, asset] of assets.entries()) {
          const destination = String(asset.sourcePath);
          expect(destinations.has(destination)).toBe(true);
          // Activate verified assets at their original absolute roots. Merely
          // changing STATE_DIR leaves configured agent/workspace roots stale.
          await rename(destination, path.join(prefix, `post-upgrade-asset-${index}`));
          await rename(path.join(target, String(asset.archivePath)), destination);
        }
        assertSchema(19, 17);
      });
      const rollbackSession = "agent:qa:package-rollback-ordinary";
      const rollbackChild = await ordinaryChild(rollbackSession);
      assertOriginalOrdinaryState();
      expect(
        agentRows("SELECT * FROM session_nodes WHERE session_key = ?", privateState.sessionKey),
      ).toEqual([]);
      phase("released-backup-rollback");

      // Isolate the feature's registry wire format from the unrelated schema-20
      // boundary. Only this captured envelope is copied into release-owned data.
      const probeParent = capturedRow.requester_session_key;
      const probeChild = capturedRow.child_session_key;
      await gateway.call("sessions.create", { key: probeParent });
      await gateway.call("sessions.create", { key: probeChild });
      const releasedChildEventCursor = events.length;
      const probeRun = record(
        await gateway.call("chat.send", {
          sessionKey: probeChild,
          idempotencyKey: capturedRow.run_id,
          message: "Subagent private completion QA worker: second. Finish with the private result.",
        }),
      );
      expect(probeRun.runId).toBe(capturedRow.run_id);
      await waitForReply(
        releasedChildEventCursor,
        { sessionKey: probeChild, runId: capturedRow.run_id, state: "final" },
        privateMarker,
      );
      const probeCursor = record(await debug("request-cursor")).cursor;
      const probeEventCursor = events.length;
      await restartState(async () => {
        assertSchema(19, 17);
        mutateRegistry(
          "INSERT INTO subagent_runs (run_id, child_session_key, controller_session_key, requester_session_key, created_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
          capturedRow.run_id,
          capturedRow.child_session_key,
          capturedRow.controller_session_key,
          capturedRow.requester_session_key,
          capturedRow.created_at,
          capturedRow.payload_json,
        );
        expect(registryRows(capturedRow.run_id)).toEqual([capturedRow]);
      });
      const atProjection = registryRows(capturedRow.run_id);
      const projection = record(await gateway.call("sessions.list", { agentId: "qa", limit: 100 }));
      expect(Array.isArray(projection.sessions)).toBe(true);
      const listed = projection.sessions as Record<string, unknown>[];
      expect(
        listed.find((session) => session.key === rollbackChild.childSessionKey)?.spawnedBy,
      ).toBe(rollbackSession);
      const privateChildProjection = listed.find((session) => session.key === probeChild);
      expect(privateChildProjection).toBeDefined();
      expect(privateChildProjection?.spawnedBy).toBeUndefined();
      expect(privateChildProjection?.controlOwnerSessionKey).toBeUndefined();
      await ordinaryChild("agent:qa:package-reader-ordinary");
      await assertPrivateHistory(probeParent);
      assertPrivateReplies(capturedReplies(probeParent, probeEventCursor));
      expect(JSON.stringify(await debug(`requests?after=${String(probeCursor)}`))).not.toMatch(
        privateMarker,
      );
      const remainingRows = registryRows(capturedRow.run_id);
      if (remainingRows.length > 0) {
        expect(remainingRows).toEqual([capturedRow]);
      }
      phase("released-registry-reader-probe", {
        syntheticRegistryFixture: true,
        capturedEnvelopeSha256: sha256(capturedRow.payload_json),
        before: capturedRow,
        atProjection,
        after: remainingRows,
        lightweightProjectionSawEnvelope: atProjection.length === 1,
        agentSchemaVersion: 19,
        sharedSchemaVersion: 17,
      });

      await restartState(async () => {
        // Remove only the synthetic probe if the old writer left it intact.
        mutateRegistry("DELETE FROM subagent_runs WHERE run_id = ?", capturedRow.run_id);
        await install(candidateTarball!);
        await runInstalled(["doctor", "--fix", "--non-interactive"]);
        assertSchema(candidateAgentSchemaVersion, candidateSharedSchemaVersion);
      });
      await ordinaryChild("agent:qa:package-reopened-ordinary");
      assertOriginalOrdinaryState();
      phase("candidate-reupgrade-after-rollback");
      expect(phases).toHaveLength(9);
      passed = true;
    } finally {
      heldProvider.release();
      await observer?.stopAndWait();
      if (owner) {
        expect(
          (await owner.stop({ preserveToDir: path.join(evidenceDir, "cycle") })).errors,
        ).toEqual([]);
      }
      await mock.stop();
      await heldProvider.stop();
      const chatEvents = events
        .filter(isRecord)
        .slice(0, 100)
        .map((event) => ({
          sessionKey: event.sessionKey,
          runId: event.runId,
          state: event.state,
          replies: JSON.stringify(replies([event.message])).slice(0, 2048),
        }));
      await writeFile(
        path.join(evidenceDir, "verdict.json"),
        `${JSON.stringify({ passed, sourceTree, candidateSha256, released: published, phases, chatEvents, proof: "Only entries in phases represent completed assertions. Real installed executables and ordinary WebChat/native-subagent controls qualify each recorded phase.", limitation: "Released schema-19 builds cannot reopen the upgraded candidate database. Rollback restores a verified pre-upgrade backup and loses post-backup work. The released registry-reader probe is synthetic envelope insertion into genuine released data, not a full database downgrade. Same-candidate restart owns receipt/pending-input durability; abrupt crash windows are covered separately by Gateway/SQLite tests. Chat observers cover connected post-startup intervals, supplemented by durable history/provider records. Child-session events and parent-session tool arguments remain operator-visible." }, null, 2)}\n`,
      );
    }
  },
  1_500_000,
);
