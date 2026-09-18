// Codex tests cover node cli sessions plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { readJsonlHead, readJsonlTail } from "./jsonl-lines.js";
import { SESSION_FILE_MAX_SUMMARY_READ_BYTES } from "./node-cli-session-files.js";
import {
  createCodexCliSessionNodeHostCommands,
  createCodexCliSessionNodeInvokePolicies,
  listCodexCliSessionsOnNode,
} from "./node-cli-sessions.js";

const CODEX_CLI_SESSIONS_LIST_COMMAND = "codex.cli.sessions.list";

type RunCommandBuffered =
  (typeof import("openclaw/plugin-sdk/process-runtime"))["runCommandBuffered"];
const processRuntimeMocks = vi.hoisted(() => ({
  runCommandBuffered: vi.fn<RunCommandBuffered>(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandBuffered: processRuntimeMocks.runCommandBuffered,
}));

let tempDir: string;
let previousCodexHome: string | undefined;

describe("codex cli node sessions", () => {
  beforeEach(async () => {
    processRuntimeMocks.runCommandBuffered.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-cli-sessions-"));
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempDir;
  });

  afterEach(async () => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lists recent sessions from Codex history and hydrates cwd from session files", async () => {
    const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd";
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      [
        JSON.stringify({ session_id: sessionId, ts: 1778677925, text: "first ask" }),
        JSON.stringify({ session_id: sessionId, ts: 1778678322, text: "latest ask" }),
        JSON.stringify({ session_id: "older", ts: 1778670000, text: "skip me" }),
      ].join("\n"),
    );
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "13");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `rollout-2026-05-13T08-29-58-${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, cwd: "/repo" },
      })}\n`,
    );

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "latest", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        cwd?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-13T13:18:42.000Z",
        lastMessage: "latest ask",
        cwd: "/repo",
        sessionFile: path.join(sessionDir, `rollout-2026-05-13T08-29-58-${sessionId}.jsonl`),
        messageCount: 2,
      },
    ]);
  });

  it("keeps authorized resume execution available while native discovery is disabled", async () => {
    processRuntimeMocks.runCommandBuffered.mockImplementation(async (argv) => {
      const outputFlag = argv.indexOf("--output-last-message");
      const outputPath = argv[outputFlag + 1];
      if (outputFlag < 0 || !outputPath) {
        throw new Error("missing Codex output path");
      }
      await fs.writeFile(outputPath, "final answer\n", "utf8");
      return {
        stdout: Buffer.from("diagnostic"),
        stderr: Buffer.alloc(0),
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    const { createPluginRegistry, createPluginRecord, createPluginRuntimeMock } =
      await import("openclaw/plugin-sdk/plugin-test-runtime");
    const config = {
      plugins: {
        entries: { codex: { enabled: true, config: { sessionCatalog: { enabled: false } } } },
      },
    };
    const registry = createPluginRegistry({
      runtime: createPluginRuntimeMock({ config: { current: () => config } }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: manifest.id,
      source: path.join(tempDir, "index.js"),
      nativeSessionCatalog: manifest.setup.nativeSessionCatalog,
    });
    registry.registry.plugins.push(record);
    const api = registry.createApi(record, { config });
    for (const nodeCommand of createCodexCliSessionNodeHostCommands()) {
      api.registerNodeHostCommand(nodeCommand);
    }
    for (const policy of createCodexCliSessionNodeInvokePolicies()) {
      api.registerNodeInvokePolicy(policy);
    }
    const commands = registry.registry.nodeHostCommands.map((entry) => entry.command);
    const list = commands.find((entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND);
    const command = commands.find((entry) => entry.command === "codex.cli.session.resume");
    if (!list || !command) {
      throw new Error("Codex node commands did not register");
    }
    await expect(list.handle()).rejects.toThrow("discovery is disabled");
    expect(command.dangerous).toBe(true);
    expect(
      registry.registry.nodeInvokePolicies.find((entry) =>
        entry.policy.commands.includes(command.command),
      )?.policy.dangerous,
    ).toBe(true);
    const raw = await command.handle(
      JSON.stringify({
        sessionId: "session-123",
        prompt: "continue this task",
        cwd: tempDir,
        timeoutMs: 12_345,
      }),
    );

    expect(JSON.parse(raw ?? "{}")).toEqual({
      ok: true,
      sessionId: "session-123",
      text: "final answer",
    });
    const [argv, options] = processRuntimeMocks.runCommandBuffered.mock.calls[0] ?? [];
    const execIndex = argv?.indexOf("exec") ?? -1;
    expect(argv?.slice(execIndex, execIndex + 7)).toEqual([
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--output-last-message",
      expect.any(String),
      "session-123",
      "-",
    ]);
    expect(options).toMatchObject({
      cwd: tempDir,
      input: "continue this task",
      killGraceMs: 2_000,
      killProcessTree: false,
      terminateOnOutputError: true,
      timeoutMs: 12_345,
    });
  });

  it("ignores Date-invalid Codex history timestamps", async () => {
    const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cf";
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      JSON.stringify({ session_id: sessionId, ts: 8_700_000_000_000, text: "bad timestamp" }),
    );

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "bad timestamp", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        updatedAt?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        lastMessage: "bad timestamp",
        messageCount: 1,
      },
    ]);
  });

  it("lists sessions from Codex session files when history is absent", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5249";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/codex-work" },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.619Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Reply with exactly: CRABBOX" }],
          },
        }),
      ].join("\n"),
    );

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "crabbox", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        cwd?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:23.619Z",
        lastMessage: "Reply with exactly: CRABBOX",
        cwd: "/tmp/codex-work",
        sessionFile,
        messageCount: 1,
      },
    ]);
  });

  it("reads a large rollout through bounded head and tail windows", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5250";
    const sessionFile = await writeRollout(sessionId, [
      sessionMeta(sessionId, "/tmp/codex-streaming"),
      userMessage("2026-05-14T00:10:23.700Z", "first ask"),
      filler(2 * 1_024 * 1_024),
      userMessage("2026-05-14T00:10:23.800Z", "buried ask"),
      filler(2 * 1_024 * 1_024),
      userMessage("2026-05-14T00:10:24.000Z", "rollout fallback"),
    ]);
    const fileSize = (await fs.stat(sessionFile)).size;
    const readFile = vi.spyOn(fs, "readFile");
    const reads = spyOnRolloutReads();

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        cwd?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(readFile).not.toHaveBeenCalledWith(sessionFile, "utf8");
    // Head (512 KiB) plus tail (256 KiB) — never the whole 4 MiB rollout.
    expect(reads.bytes()).toBeLessThanOrEqual(768 * 1_024);
    expect(fileSize).toBeGreaterThan(4 * 1_024 * 1_024);
    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:24.000Z",
        cwd: "/tmp/codex-streaming",
        // Exact: the last user message lives in the tail window.
        lastMessage: "rollout fallback",
        sessionFile,
        // Windowed: "buried ask" sits between the two windows, so the count is marked partial.
        messageCount: 2,
        partialScan: true,
      },
    ]);
  });

  it("counts each record once when an oversized session_meta escalates past the file size", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5260";
    const sessionFile = await writeRollout(sessionId, [
      sessionMeta(sessionId, "/tmp/codex-escalated", 900 * 1_024),
      userMessage("2026-05-14T00:10:24.100Z", "one"),
      userMessage("2026-05-14T00:10:24.200Z", "two"),
      userMessage("2026-05-14T00:10:24.300Z", "three"),
    ]);
    const size = (await fs.stat(sessionFile)).size;
    // Larger than the head window, so the first read finds no complete record and escalates; small
    // enough that the escalated read reaches EOF, which is where a fixed tail would re-read.
    expect(size).toBeGreaterThan(768 * 1_024);
    expect(size).toBeLessThan(4 * 1_024 * 1_024);

    const parsed = await runSessionsList({ limit: 5 });

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:24.300Z",
        lastMessage: "three",
        cwd: "/tmp/codex-escalated",
        sessionFile,
        messageCount: 3,
      },
    ]);
  });

  it("counts each record once when the escalated head window meets the tail window", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5261";
    const records = [sessionMeta(sessionId, "/tmp/codex-overlap", 900 * 1_024)];
    let bytes = records[0].length + 1;
    const padTo = (target: number) => {
      while (bytes < target) {
        const record = filler(Math.min(256 * 1_024, target - bytes));
        records.push(record);
        bytes += record.length + 1;
      }
    };
    padTo(3_950 * 1_024);
    records.push(userMessage("2026-05-14T00:10:25.100Z", "overlap ask"));
    bytes += records.at(-1)?.length ?? 0;
    padTo(4_150 * 1_024);
    records.push(userMessage("2026-05-14T00:10:25.200Z", "final ask"));
    const sessionFile = await writeRollout(sessionId, records);
    // Pin the property the fixture exists to exercise rather than the sizes that produce it: an
    // unanchored tail reaches back before the head stopped, and "overlap ask" is inside that span.
    const head = await readJsonlHead(sessionFile, 4 * 1_024 * 1_024);
    const unanchored = await readJsonlTail(sessionFile, 256 * 1_024);
    expect(head?.complete).toBe(false);
    expect(unanchored?.start).toBeLessThan(head?.endOffset ?? 0);
    expect(unanchored?.lines.join("\n")).toContain("overlap ask");
    expect(head?.lines.join("\n")).toContain("overlap ask");

    const parsed = await runSessionsList({ limit: 5 });

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:25.200Z",
        lastMessage: "final ask",
        cwd: "/tmp/codex-overlap",
        sessionFile,
        // Two user records, each scanned once: the windows meet, so the count stays exact.
        messageCount: 2,
      },
    ]);
  });

  it("falls back to mtime when the tail window holds no complete record", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5262";
    const mtime = new Date("2026-05-20T11:22:33.000Z");
    const sessionFile = await writeRollout(sessionId, [
      sessionMeta(sessionId, "/tmp/codex-huge-tail"),
      userMessage("2026-05-14T00:10:23.700Z", "early ask"),
      filler(700 * 1_024),
      // One record wider than the tail window, so the window opens mid-record and ends at EOF.
      filler(400 * 1_024),
    ]);
    await fs.utimes(sessionFile, mtime, mtime);

    const parsed = await runSessionsList({ limit: 5 });

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        // Not the head's "2026-05-14T00:10:23.700Z": records after it went unread.
        updatedAt: mtime.toISOString(),
        lastMessage: "early ask",
        cwd: "/tmp/codex-huge-tail",
        sessionFile,
        messageCount: 1,
        partialScan: true,
      },
    ]);
  });

  it("keeps exact counts for rollouts small enough to read whole", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5253";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/codex-small" },
        }),
        ...["one", "two", "three"].map((text, index) =>
          JSON.stringify({
            timestamp: `2026-05-14T00:10:2${String(index + 4)}.000Z`,
            type: "response_item",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
          }),
        ),
      ].join("\n"),
    );

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 5 }));

    expect(JSON.parse(raw ?? "{}")).toMatchObject({
      sessions: [
        {
          sessionId,
          lastMessage: "three",
          messageCount: 3,
        },
      ],
    });
    expect(JSON.parse(raw ?? "{}").sessions[0]).not.toHaveProperty("partialScan");
  });

  it("scans only the most recent rollouts past the requested limit", async () => {
    const opened = await writeRolloutFixtures(40);

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const reads = spyOnRolloutReads();
    const raw = await command?.handle(JSON.stringify({ limit: 2 }));
    const parsed = JSON.parse(raw ?? "{}") as { sessions?: Array<{ sessionId?: string }> };

    // limit (2) + SESSION_FILE_SCAN_HEADROOM (20), newest first — not all 40 rollouts.
    expect(reads.files().size).toBe(22);
    expect(parsed.sessions?.map((entry) => entry.sessionId)).toEqual([
      opened[0]?.sessionId,
      opened[1]?.sessionId,
    ]);
  });

  it("finds a session by id even when it is older than the scan window", async () => {
    const rollouts = await writeRolloutFixtures(210);
    const oldest = rollouts.at(-1);

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 50, filter: oldest?.sessionId }));
    const parsed = JSON.parse(raw ?? "{}") as { sessions?: Array<{ sessionId?: string }> };

    expect(parsed.sessions?.map((entry) => entry.sessionId)).toEqual([oldest?.sessionId]);
  });

  it("finds a session by cwd past the rollout count a filtered scan used to stop at", async () => {
    const rollouts = await writeRolloutFixtures(210, {
      cwdFor: (index) => (index === 209 ? "/tmp/codex-archive" : "/tmp/codex-many"),
    });
    const oldest = rollouts.at(-1);

    const parsed = await runSessionsList({ limit: 50, filter: "/tmp/codex-archive" });

    // Nothing in its filename matches, so this session is only reachable by reading past the 200th
    // rollout. A scan that stops earlier has to report itself truncated instead of answering "none".
    expect(parsed.sessions?.map((entry) => entry.sessionId)).toEqual([oldest?.sessionId]);
    expect(parsed).toMatchObject({ scannedFileCount: 210, sessionFileCount: 210 });
    expect(parsed).not.toHaveProperty("searchTruncated");
  });

  it("stops a filtered scan once the page is full and reports the search as truncated", async () => {
    await writeRolloutFixtures(60);

    const parsed = await runSessionsList({ limit: 5, filter: "/tmp/codex-many" });

    // limit (5) + SESSION_FILE_SCAN_HEADROOM (20) matches is enough to fill a newest-first page,
    // so the remaining 35 rollouts stay unread — and the result says the search was cut.
    expect(parsed.sessions).toHaveLength(5);
    expect(parsed).toMatchObject({
      scannedFileCount: 25,
      sessionFileCount: 60,
      searchTruncated: true,
    });
  });

  it("stops a filtered scan at the byte budget and reports the search as truncated", async () => {
    // A 768 KiB rollout is read head-and-tail in one window, so each one spends 768 KiB of the
    // 256 MiB budget. The budget is checked between files against bytes already spent, so the scan
    // reads one file past the point where it runs out: 342 rather than 341.
    await writeRolloutFixtures(345, {
      cwdFor: () => "/tmp/codex-budget",
      padToBytes: 768 * 1024,
    });

    const parsed = await runSessionsList({ limit: 50, filter: "/tmp/codex-unmatched" });

    expect(parsed.sessions).toEqual([]);
    expect(parsed).toMatchObject({
      scannedFileCount: 342,
      sessionFileCount: 345,
      searchTruncated: true,
    });
  });

  it("charges the oversized-session_meta escalation against the filtered scan budget", async () => {
    // Every rollout here forces the escalation: `session_meta` is wider than the 512 KiB initial
    // head window, so each file costs 512 KiB + a 1 MiB re-read, not the 768 KiB an estimate based
    // on `min(size, head + tail)` would have charged. Under that estimate 175 rollouts fit inside
    // the 256 MiB budget and the scan reported itself complete while reading ~262 MB; the budget
    // has to be charged what was actually read.
    await writeRolloutFixtures(175, {
      cwdFor: () => "/tmp/codex-escalated",
      metaPadBytes: 600_000,
      padToBytes: 1024 * 1024,
    });

    const reads = spyOnRolloutReads();
    const parsed = await runSessionsList({ limit: 50, filter: "/tmp/codex-unmatched" });

    expect(parsed.sessions).toEqual([]);
    expect(parsed).toMatchObject({ sessionFileCount: 175, searchTruncated: true });
    // 512 KiB + a 1 MiB re-read each, so 256 MiB runs out after 171 of the 175 rollouts.
    // Charging `min(size, head + tail)` instead would have called all 175 a complete search.
    expect(parsed.scannedFileCount).toBe(171);
    // The stated bound: the budget plus at most one file's maximum summary read.
    expect(reads.bytes()).toBeLessThanOrEqual(
      256 * 1024 * 1024 + SESSION_FILE_MAX_SUMMARY_READ_BYTES,
    );
  });

  it("keeps an unfiltered listing free of the truncation marker", async () => {
    await writeRolloutFixtures(40);

    const parsed = await runSessionsList({ limit: 2 });

    expect(parsed).toMatchObject({ scannedFileCount: 22, sessionFileCount: 40 });
    expect(parsed).not.toHaveProperty("searchTruncated");
  });

  it("reads cwd from an oversized session_meta on a history-backed session outside the scan window", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a52aa";
    await writeRolloutFixtures(25);
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-13T00-00-00-${sessionId}.jsonl`);
    // A `session_meta` past the 512 KiB head window. Only the escalation to 4 MiB reaches it.
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        timestamp: "2026-05-13T00:00:01.000Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "/tmp/codex-oversized", instructions: "x".repeat(600_000) },
      })}\n`,
    );
    const stale = new Date(Date.UTC(2026, 4, 13));
    await fs.utimes(sessionFile, stale, stale);
    // History makes this the newest session even though its rollout is the oldest file on disk, so
    // it lands in the listing while sitting outside the rollouts the summary scan reads.
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      `${JSON.stringify({ session_id: sessionId, ts: 1800000000, text: "oversized meta ask" })}\n`,
    );

    const parsed = await runSessionsList({ limit: 1 });

    expect(parsed.sessions).toMatchObject([{ sessionId, cwd: "/tmp/codex-oversized" }]);
  });

  it("reports a search as cut when a filtered-out summary had an unread span", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5270";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    // One rollout, no history.jsonl, and the only record carrying the filter term sits between the
    // head and tail windows: 600 KB of filler pushes it past the 512 KiB head, and a final 400 KB
    // agent record with no trailing newline fills the 256 KiB tail so the tail yields no record.
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:20.000Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/window-gap" },
        }),
        userMessage("2026-05-14T00:10:21.000Z", "early ask"),
        filler(600_000),
        userMessage("2026-05-14T00:10:25.000Z", "please check needle-term now"),
        JSON.stringify({
          timestamp: "2026-05-14T00:10:26.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "y".repeat(400_000) }],
          },
        }),
      ].join("\n"),
    );

    const parsed = await runSessionsList({ limit: 50, filter: "needle-term" });

    // Every file was opened, so a file-count comparison alone calls this a complete search. It is
    // not: the one record that matches was never read, and answering "none" without qualification
    // asserts the session does not exist.
    expect(parsed.sessions).toEqual([]);
    expect(parsed).toMatchObject({
      scannedFileCount: 1,
      sessionFileCount: 1,
      searchTruncated: true,
      unreadSpanCount: 1,
    });
  });

  it("keeps a session whose metadata and final record both outrun their windows", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5260";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    // One record wider than the 4 MiB head escalation, and no newline anywhere after it — so the
    // head window yields nothing and the 256 KiB tail window opens inside the same record.
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        timestamp: "2026-05-14T00:10:23.618Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "/tmp/huge-meta", instructions: "x".repeat(5_000_000) },
      })}\n`,
    );
    const updatedAt = new Date(Date.UTC(2026, 4, 14));
    await fs.utimes(sessionFile, updatedAt, updatedAt);

    const parsed = await runSessionsList({ limit: 5, filter: sessionId });

    // Unreadable windows are not an absent session: the id is in the filename, and dropping the
    // row here would also make `/codex resume <id> --bind` unable to resolve it.
    expect(parsed.sessions).toMatchObject([
      { sessionId, sessionFile, partialScan: true, messageCount: 0 },
    ]);
  });

  it("discards partial large-file summaries and closes after a later read fails", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5251";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(sessionFile, "");
    await fs.truncate(sessionFile, 5 * 1_024 * 1_024);
    const firstChunk = Buffer.from(
      `${JSON.stringify({
        timestamp: "2026-05-14T00:10:23.618Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "/tmp/partial" },
      })}\n`,
    );
    const close = vi.fn(async () => undefined);
    const read = vi
      .fn()
      .mockImplementationOnce(async (buffer: Buffer) => {
        firstChunk.copy(buffer);
        return { bytesRead: firstChunk.length, buffer };
      })
      .mockRejectedValueOnce(Object.assign(new Error("read failed"), { code: "EIO" }));
    vi.spyOn(fs, "open").mockResolvedValue({ read, close } as never);

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as { sessions?: unknown[] };

    expect(parsed.sessions).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps a completed summary when close rejects", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5252";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    const content = Buffer.from(
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/close-failure" },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T00:10:24.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "survives close failure" }],
          },
        }),
      ].join("\n"),
    );
    await fs.writeFile(sessionFile, content);
    const close = vi.fn(async () => {
      throw Object.assign(new Error("close failed"), { code: "EIO" });
    });
    const read = vi.fn(async (buffer: Buffer) => {
      content.copy(buffer);
      return { bytesRead: content.length, buffer };
    });
    vi.spyOn(fs, "open").mockResolvedValue({ read, close } as never);

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        updatedAt?: string;
        cwd?: string;
        lastMessage?: string;
        sessionFile?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:24.000Z",
        cwd: "/tmp/close-failure",
        lastMessage: "survives close failure",
        sessionFile,
        messageCount: 1,
      },
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports malformed node session payloadJSON with an owned error", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payloadJSON: "{not json",
    }));
    const runtime = {
      nodes: {
        list: vi.fn(async () => ({
          nodes: [
            {
              nodeId: "node-1",
              connected: true,
              commands: [CODEX_CLI_SESSIONS_LIST_COMMAND],
            },
          ],
        })),
        invoke,
      },
    } as unknown as PluginRuntime;

    await expect(
      listCodexCliSessionsOnNode({
        runtime,
        requestedNode: "node-1",
      }),
    ).rejects.toThrow("Codex CLI node command returned malformed payloadJSON.");
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["operator.write"] }));
  });

  it("leaves rollout counts absent when a node build does not report them", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payloadJSON: JSON.stringify({
        codexHome: "/Users/mariano/.codex",
        searchTruncated: true,
        sessions: [],
      }),
    }));
    const runtime = {
      nodes: {
        list: vi.fn(async () => ({
          nodes: [
            { nodeId: "node-1", connected: true, commands: [CODEX_CLI_SESSIONS_LIST_COMMAND] },
          ],
        })),
        invoke,
      },
    } as unknown as PluginRuntime;

    const listing = await listCodexCliSessionsOnNode({ runtime, requestedNode: "node-1" });

    // Coercing an absent counter to 0 would make the truncation notice claim "0 of 0 rollouts".
    expect(listing.result.scannedFileCount).toBeUndefined();
    expect(listing.result.sessionFileCount).toBeUndefined();
    expect(listing.result.searchTruncated).toBe(true);
  });

  it("keeps Codex history session previews on UTF-16 code point boundaries", async () => {
    const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5ce";
    const text = `${"a".repeat(136)}🤖tail`;
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      JSON.stringify({ session_id: sessionId, ts: 1778678322, text }),
    );

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{ lastMessage?: string }>;
    };

    expect(parsed.sessions?.[0]?.lastMessage).toBe(`${"a".repeat(136)}...`);
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\ud83e");
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\udd16");
  });

  it("keeps Codex session-file previews on UTF-16 code point boundaries", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5248";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    const text = `${"b".repeat(136)}🤖tail`;

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/codex-work" },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.619Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        }),
      ].join("\n"),
    );

    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{ lastMessage?: string }>;
    };

    expect(parsed.sessions?.[0]?.lastMessage).toBe(`${"b".repeat(136)}...`);
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\ud83e");
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\udd16");
  });

  function sessionMeta(sessionId: string, cwd: string, padding = 0): string {
    return JSON.stringify({
      timestamp: "2026-05-14T00:10:23.618Z",
      type: "session_meta",
      // Real rollouts embed the whole instruction set here, which is what makes this record big.
      payload: { id: sessionId, cwd, instructions: "i".repeat(padding) },
    });
  }

  function userMessage(timestamp: string, text: string): string {
    return JSON.stringify({
      timestamp,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
  }

  function filler(padding: number): string {
    return JSON.stringify({
      timestamp: "2026-05-14T00:10:23.619Z",
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(padding) },
    });
  }

  async function writeRollout(sessionId: string, records: string[]): Promise<string> {
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.writeFile(sessionFile, records.join("\n"));
    return sessionFile;
  }

  async function runSessionsList(params: Record<string, unknown>): Promise<{
    sessions?: Array<Record<string, unknown>>;
    scannedFileCount?: number;
    sessionFileCount?: number;
    searchTruncated?: boolean;
    unreadSpanCount?: number;
  }> {
    const command = createCodexCliSessionNodeHostCommands().find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    return JSON.parse((await command?.handle(JSON.stringify(params))) ?? "{}") as {
      sessions?: Array<Record<string, unknown>>;
      scannedFileCount?: number;
      sessionFileCount?: number;
      searchTruncated?: boolean;
      unreadSpanCount?: number;
    };
  }

  /** Writes `count` rollouts, newest first, with distinct mtimes so recency ordering is stable. */
  async function writeRolloutFixtures(
    count: number,
    options?: {
      cwdFor?: (index: number) => string;
      padToBytes?: number;
      /** Pads `session_meta` itself, so the record is wider than the initial head window. */
      metaPadBytes?: number;
    },
  ): Promise<Array<{ sessionId: string; file: string }>> {
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    await fs.mkdir(sessionDir, { recursive: true });
    const created: Array<{ sessionId: string; file: string }> = [];
    for (let index = 0; index < count; index += 1) {
      const sessionId = `019e23d1-f33d-78e3-959e-${index.toString(16).padStart(12, "0")}`;
      const file = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
      const updatedAt = new Date(Date.UTC(2026, 4, 14) - index * 60_000);
      await fs.writeFile(
        file,
        [
          JSON.stringify({
            timestamp: updatedAt.toISOString(),
            type: "session_meta",
            payload: {
              id: sessionId,
              cwd: options?.cwdFor?.(index) ?? "/tmp/codex-many",
              ...(options?.metaPadBytes ? { instructions: "x".repeat(options.metaPadBytes) } : {}),
            },
          }),
          JSON.stringify({
            timestamp: updatedAt.toISOString(),
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `ask ${String(index)}` }],
            },
          }),
        ].join("\n"),
      );
      if (options?.padToBytes) {
        // Sparse padding: the scan charges its window against the budget without the fixture
        // costing that many bytes on disk.
        await fs.truncate(file, options.padToBytes);
      }
      await fs.utimes(file, updatedAt, updatedAt);
      created.push({ sessionId, file });
    }
    return created;
  }

  /** Records which rollouts were opened and how many bytes each listing actually read. */
  function spyOnRolloutReads(): { files: () => Set<string>; bytes: () => number } {
    const openFile = fs.open;
    const files = new Set<string>();
    let bytes = 0;
    vi.spyOn(fs, "open").mockImplementation((async (file: string, flags: string) => {
      files.add(file);
      const handle = await openFile(file, flags);
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          const result = await handle.read(buffer, offset, length, position);
          bytes += result.bytesRead;
          return result;
        },
        close: () => handle.close(),
      };
    }) as never);
    return { files: () => files, bytes: () => bytes };
  }
});
