import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkOpenCodeUpstreamActivity,
  linkContinuedOpenCodeSession,
} from "./session-upstream-activity.js";

type StatefulOpenCodeSession = {
  id: string;
  title: string;
  directory: string;
  seq?: number | string | null;
  messages: Array<{
    info: { id: string; role: string; time: { created: number } };
    parts: Array<{
      id: string;
      type: string;
      text?: string;
      synthetic?: boolean;
      ignored?: boolean;
      metadata?: Record<string, unknown>;
      mime?: string;
      filename?: string;
      source?: { text: { value: string; start: number; end: number } };
    }>;
  }>;
};

type Probe = Parameters<typeof checkOpenCodeUpstreamActivity>[0][number];

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

async function installStatefulOpenCode(initialSessions: StatefulOpenCodeSession[], version = 1) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-opencode-activity-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "opencode");
  const stateFile = path.join(directory, "state.json");
  const logFile = path.join(directory, "calls.jsonl");
  const activeExportsDirectory = path.join(directory, "active-exports");
  const exportConcurrencyLog = path.join(directory, "export-concurrency.log");
  await fs.mkdir(activeExportsDirectory);
  const writeState = async (state: {
    sessions: StatefulOpenCodeSession[];
    failDb?: boolean;
    failExports?: string[];
    exportDelayMs?: number;
  }) => await fs.writeFile(stateFile, JSON.stringify(state));
  await writeState({ sessions: initialSessions });
  await fs.writeFile(logFile, "");
  await fs.writeFile(
    `${executable}.js`,
    "#!/usr/bin/env node\n" +
      `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(`${version}.0.0`)});
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
if (${version} === 2) {
  if (args.includes("--pure") || !args.includes("--standalone")) process.exit(2);
  if (args[0] === "api" && state.failDb) process.exit(4);
  const id = args[0] === "api"
    ? args.find((arg) => arg.startsWith("sessionID="))?.slice(10)
    : args.at(-1);
  const session = state.sessions.find((candidate) => candidate.id === id);
  if (!session) {
    process.stdout.write(JSON.stringify({ _tag: "SessionNotFoundError", sessionID: id }));
    process.stderr.write("HTTP 404 Not Found");
    process.exit(1);
  }
  if (args[0] === "api" && args[2] === "session.log") {
    if (state.failDb) process.exit(4);
    process.stdout.write("data: " + JSON.stringify({ type: "log.synced", aggregateID: id, seq: session.seq }) + "\\n\\n");
  } else if (args[0] === "session" && args[1] === "export") {
    if (state.failExports?.includes(id)) process.exit(5);
    process.stdout.write(JSON.stringify({ info: session, messages: session.messages.map((message) => ({
      id: message.info.id, type: message.info.role, time: message.info.time,
      ...(message.info.role === "user"
        ? { text: message.parts.map((part) => part.text ?? "").join("\\n") }
        : { content: message.parts }),
    })) }));
  } else process.exitCode = 2;
  process.exit();
}
if (args[0] === "--pure" && args[1] === "db") {
  if (state.failDb) process.exit(4);
  const query = args[2];
  const selected = state.sessions.filter((session) => query.includes("'" + session.id + "'"));
  process.stdout.write(JSON.stringify(selected.map((session) => ({
    id: session.id,
    seq: session.seq ?? null,
  }))));
} else if (args[0] === "--pure" && args[1] === "export") {
  const session = state.sessions.find((candidate) => candidate.id === args[2]);
  if (!session || state.failExports?.includes(args[2])) process.exit(5);
  const activeMarker = ${JSON.stringify(activeExportsDirectory)} + "/" + process.pid;
  fs.writeFileSync(activeMarker, "");
  fs.appendFileSync(
    ${JSON.stringify(exportConcurrencyLog)},
    String(fs.readdirSync(${JSON.stringify(activeExportsDirectory)}).length) + "\\n",
  );
  const finish = () => {
    fs.rmSync(activeMarker, { force: true });
    process.stdout.write(JSON.stringify({ info: session, messages: session.messages }));
  };
  if (state.exportDelayMs) setTimeout(finish, state.exportDelayMs);
  else finish();
} else {
  process.exit(2);
}
`,
  );
  // Keep generated payload writers out of the kernel's executable inode check.
  await fs.symlink(new URL("./test-fixtures/opencode-command.sh", import.meta.url), executable);
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
  return {
    writeState,
    clearLog: async () => await fs.writeFile(logFile, ""),
    readCalls: async () =>
      (await fs.readFile(logFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    readMaxExportConcurrency: async () =>
      Math.max(
        0,
        ...(await fs.readFile(exportConcurrencyLog, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(Number),
      ),
  };
}

function openCodeSession(
  seq: number | undefined,
  messages: StatefulOpenCodeSession["messages"],
): StatefulOpenCodeSession {
  return { id: "ses_a", title: "Session A", directory: "/workspace/a", seq, messages };
}

function message(
  id: string,
  parts: StatefulOpenCodeSession["messages"][number]["parts"],
  offset = 0,
) {
  return { info: { id, role: "user", time: { created: 1_700_000_000_000 + offset } }, parts };
}

type Part = StatefulOpenCodeSession["messages"][number]["parts"][number];
const part = (type: string, fields: Omit<Part, "id" | "type"> = {}): Part => ({
  id: `part-${type}-${fields.text ?? fields.filename ?? ""}`,
  type,
  ...fields,
});
const text = (value: string, fields: Omit<Part, "id" | "type" | "text"> = {}) =>
  part("text", { text: value, ...fields });
const changed = (humanTurns: number, seq?: number, lastHumanMessageId?: string | null) => [
  expect.objectContaining({
    humanTurns,
    ...(seq === undefined ? {} : { nextMarker: { seq, lastHumanMessageId } }),
  }),
];

function activity(seq: number, lastHumanMessageId: string | null, humanTurns: number) {
  return {
    kind: "activity",
    sessionKey: "agent:main:ses-a",
    humanTurns,
    nextMarker: { seq, lastHumanMessageId },
  };
}

function textMessage(id: string, role: string, value: string, offset = 0) {
  return {
    info: { id, role, time: { created: 1_700_000_000_000 + offset } },
    parts: [text(value)],
  };
}

function probe(marker: Probe["marker"], ownRecentUserTexts: string[] = []): Probe {
  return {
    sessionKey: "agent:main:ses-a",
    agentId: "main",
    threadId: "ses_a",
    hostId: "gateway",
    upstreamKind: "opencode-cli",
    upstreamRef: { threadId: "ses_a" },
    marker,
    ownRecentUserTexts,
  };
}

const checkActivity = (marker: Probe["marker"], ownRecentUserTexts: string[] = []) =>
  checkOpenCodeUpstreamActivity([probe(marker, ownRecentUserTexts)]);

function markerFrom(
  outcome: Awaited<ReturnType<typeof checkOpenCodeUpstreamActivity>>[number] | undefined,
) {
  if (outcome?.kind !== "activity") {
    throw new Error("expected activity marker");
  }
  return outcome.nextMarker;
}

const itWithCli = it.runIf(process.platform !== "win32");

describe("OpenCode session upstream activity", () => {
  it.runIf(process.platform !== "win32").each([1, 2])(
    "uses v%s event cursors and exports only after the cursor advances",
    async (version) => {
      const session: StatefulOpenCodeSession = openCodeSession(1, [
        textMessage("msg_001", "assistant", "ready"),
      ]);
      const fixture = await installStatefulOpenCode([session], version);
      const continued = await linkContinuedOpenCodeSession("agent:main:ses-a", "ses_a");
      expect(continued.upstream?.marker).toEqual({ seq: 1, lastHumanMessageId: null });

      await fixture.clearLog();
      await expect(checkActivity(continued.upstream!.marker)).resolves.toEqual([]);
      let calls = await fixture.readCalls();
      expect(calls).toHaveLength(1);

      session.messages.push(textMessage("msg_002", "user", "external OpenCode turn", 1000));
      session.seq = 3;
      await fixture.writeState({ sessions: [session] });
      await fixture.clearLog();
      await expect(checkActivity(continued.upstream!.marker)).resolves.toEqual([
        expect.objectContaining({
          kind: "activity",
          humanTurns: 1,
          dedupeId: "msg_002",
          nextMarker: { seq: 3, lastHumanMessageId: "msg_002" },
        }),
      ]);
      calls = await fixture.readCalls();
      expect(calls).toHaveLength(2);
      expect(calls.filter((args) => args[1] === "export")).toHaveLength(1);
    },
  );

  // OpenCode 2.0.16 omits seq when the captured log watermark is empty.
  itWithCli("released v2 empty log watermark is a valid zero baseline", async () => {
    await installStatefulOpenCode([openCodeSession(undefined, [])], 2);
    const result = await linkContinuedOpenCodeSession("agent:main:ses-a", "ses_a");
    expect(result.upstream?.marker).toEqual({ seq: 0, lastHumanMessageId: null });
  });

  itWithCli.each([null, "0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid present v2 log watermark (%s)",
    async (seq) => {
      await installStatefulOpenCode([{ ...openCodeSession(undefined, []), seq }], 2);
      await expect(linkContinuedOpenCodeSession("agent:main:ses-a", "ses_a")).resolves.toEqual({
        sessionKey: "agent:main:ses-a",
      });
    },
  );

  itWithCli("re-baselines a regressed cursor and keeps monitoring the next advance", async () => {
    const session = openCodeSession(0, [textMessage("msg_001", "user", "old turn")]);
    const fixture = await installStatefulOpenCode([session]);
    const reset = await checkActivity({ seq: 12, lastHumanMessageId: "msg_001" });
    expect(reset).toEqual([activity(0, "msg_001", 0)]);
    expect((await fixture.readCalls()).filter((args) => args[1] === "export")).toHaveLength(0);

    session.messages.push(textMessage("msg_002", "user", "new after migration", 1000));
    session.seq = 2;
    await fixture.writeState({ sessions: [session] });
    await expect(checkActivity(markerFrom(reset[0]))).resolves.toEqual([
      expect.objectContaining({
        humanTurns: 1,
        nextMarker: { seq: 2, lastHumanMessageId: "msg_002" },
      }),
    ]);
  });

  itWithCli(
    "waits across staged part projections and reports the human turn exactly once",
    async () => {
      const session = openCodeSession(1, [textMessage("msg_001", "assistant", "ready")]);
      const fixture = await installStatefulOpenCode([session]);
      let currentMarker: Probe["marker"] = { seq: 1, lastHumanMessageId: null };
      const user = message("msg_002", [], 1000);
      session.messages.push(user);
      const stages = [
        { addition: [], expected: changed(0) },
        { addition: [part("file")], expected: changed(0) },
        { addition: [text("arrived in stages")], expected: changed(1, 4, "msg_002") },
        { addition: [text("late detail")], expected: changed(0, 5, "msg_002") },
      ];
      for (const [index, { addition, expected }] of stages.entries()) {
        user.parts.push(...addition);
        session.seq = index + 2;
        await fixture.writeState({ sessions: [session] });
        const outcomes = await checkActivity(currentMarker);
        expect(outcomes).toEqual(expected);
        currentMarker = markerFrom(outcomes[0]);
      }
    },
  );

  itWithCli("suppresses compaction replay text duplicated from an earlier user turn", async () => {
    const session = openCodeSession(9, [
      message("msg_001", [text("hidden", { ignored: true }), text("please keep going")]),
      textMessage("msg_002", "assistant", "working", 1000),
      message("msg_003", [part("compaction")], 2000),
      textMessage("msg_004", "assistant", "summary", 3000),
      textMessage("msg_005", "user", "  please   keep going ", 4000),
    ]);
    await installStatefulOpenCode([session]);
    await expect(checkActivity({ seq: 4, lastHumanMessageId: "msg_001" })).resolves.toEqual([
      activity(9, "msg_005", 0),
    ]);
  });

  itWithCli("normalizes media placeholders when suppressing compaction replay", async () => {
    const session = openCodeSession(7, [
      message("msg_001", [part("file", { mime: "image/png", filename: "screen.png" })]),
      textMessage("msg_002", "assistant", "working", 1000),
      message("msg_003", [part("compaction")], 2000),
      textMessage("msg_004", "assistant", "summary", 3000),
      textMessage("msg_005", "user", "[Attached image/png: screen.png]", 4000),
    ]);
    await installStatefulOpenCode([session]);
    await expect(checkActivity({ seq: 2, lastHumanMessageId: null })).resolves.toEqual([
      activity(7, "msg_005", 0),
    ]);
  });

  itWithCli("bounds replay suppression to the preceding 50 user messages", async () => {
    const session = openCodeSession(80, [
      textMessage("msg_001", "user", "repeat me"),
      ...Array.from({ length: 50 }, (_, index) =>
        message(
          `msg_${String(index + 2).padStart(3, "0")}`,
          [text("internal", { synthetic: true })],
          1000 + index,
        ),
      ),
      textMessage("msg_052", "user", "repeat me", 52000),
    ]);
    await installStatefulOpenCode([session]);
    await expect(checkActivity({ seq: 1, lastHumanMessageId: "msg_001" })).resolves.toEqual(
      changed(1, 80, "msg_052"),
    );
  });

  itWithCli(
    "suppresses ignored, synthetic, shell, compaction, and continuation user rows",
    async () => {
      const session = openCodeSession(12, [
        textMessage("msg_001", "assistant", "ready"),
        message("msg_002", [text("hidden", { ignored: true })], 1000),
        message("msg_003", [text("hidden", { synthetic: true })], 2000),
        textMessage("msg_004", "user", "The following tool was executed by the user", 3000),
        message("msg_005", [text("looks human"), part("compaction")], 4000),
        message("msg_006", [text("continue", { metadata: { compaction_continue: true } })], 5000),
      ]);
      await installStatefulOpenCode([session]);
      await expect(checkActivity({ seq: 1, lastHumanMessageId: null })).resolves.toEqual([
        activity(12, null, 0),
      ]);
    },
  );

  itWithCli("does not report a file-mention-only turn", async () => {
    const session = openCodeSession(3, [
      textMessage("msg_001", "assistant", "ready"),
      message(
        "msg_002",
        [
          text("@notes.ts"),
          part("file", {
            mime: "text/plain",
            filename: "notes.ts",
            source: { text: { value: "@notes.ts", start: 0, end: 9 } },
          }),
        ],
        1000,
      ),
    ]);
    await installStatefulOpenCode([session]);
    await expect(checkActivity({ seq: 1, lastHumanMessageId: null })).resolves.toEqual([
      activity(3, null, 0),
    ]);
  });

  itWithCli(
    "keeps real text mixed with ignored text and suppresses OpenClaw self-echo",
    async () => {
      const session = openCodeSession(4, [
        message("msg_001", [text("hidden", { ignored: true }), text("real external turn")], 1000),
      ]);
      const fixture = await installStatefulOpenCode([session]);
      await expect(checkActivity({ seq: 0, lastHumanMessageId: null })).resolves.toEqual([
        expect.objectContaining({ humanTurns: 1 }),
      ]);
      await expect(
        checkActivity({ seq: 0, lastHumanMessageId: null }, ["real external turn"]),
      ).resolves.toEqual(changed(0, 4, "msg_001"));

      session.messages.push(textMessage("msg_002", "assistant", "summary", 2000));
      session.seq = 5;
      await fixture.writeState({ sessions: [session] });
      const suppressed = await checkActivity({ seq: 4, lastHumanMessageId: "msg_001" });
      expect(suppressed).toEqual([expect.objectContaining({ humanTurns: 0 })]);
    },
  );

  it.runIf(process.platform !== "win32").each([1, 2])(
    "reports v%s confirmed absence but not query or export failures",
    async (version) => {
      const session: StatefulOpenCodeSession = openCodeSession(2, [
        textMessage("msg_001", "user", "external", 1000),
      ]);
      const fixture = await installStatefulOpenCode([session], version);
      const currentProbe = probe({ seq: 1, lastHumanMessageId: null });

      await fixture.writeState({ sessions: [], failDb: true });
      await expect(checkOpenCodeUpstreamActivity([currentProbe])).resolves.toEqual([]);

      await fixture.writeState({ sessions: [session], failExports: ["ses_a"] });
      await expect(checkOpenCodeUpstreamActivity([currentProbe])).resolves.toEqual([]);

      await fixture.writeState({ sessions: [] });
      await expect(checkOpenCodeUpstreamActivity([currentProbe])).resolves.toEqual([
        { kind: "missing", sessionKey: "agent:main:ses-a" },
      ]);
    },
  );

  itWithCli("treats a missing event_sequence row as sequence zero", async () => {
    const session = openCodeSession(undefined, []);
    await installStatefulOpenCode([session]);
    await expect(linkContinuedOpenCodeSession("agent:main:ses-a", "ses_a")).resolves.toEqual({
      sessionKey: "agent:main:ses-a",
      upstream: {
        kind: "opencode-cli",
        ref: { threadId: "ses_a" },
        marker: { seq: 0, lastHumanMessageId: null },
      },
    });
  });

  itWithCli("bounds concurrent exports when many cursors advance", async () => {
    const sessions: StatefulOpenCodeSession[] = Array.from({ length: 9 }, (_, index) => ({
      id: `ses_${String(index)}`,
      title: `Session ${String(index)}`,
      directory: `/workspace/${String(index)}`,
      seq: 2,
      messages: [textMessage(`msg_${String(index)}`, "assistant", "ready", 1000 + index)],
    }));
    const fixture = await installStatefulOpenCode(sessions);
    await fixture.writeState({ sessions, exportDelayMs: 250 });

    await expect(
      checkOpenCodeUpstreamActivity(
        sessions.map((session) => ({
          ...probe({ seq: 1, lastHumanMessageId: null }),
          sessionKey: `agent:main:${session.id}`,
          threadId: session.id,
          upstreamRef: { threadId: session.id },
        })),
      ),
    ).resolves.toHaveLength(sessions.length);
    expect(await fixture.readMaxExportConcurrency()).toBeGreaterThan(0);
    expect(await fixture.readMaxExportConcurrency()).toBeLessThanOrEqual(4);
  });
});
