import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  LocalSessionSourceHost,
  LocalSessionSourceSession,
} from "openclaw/plugin-sdk/local-session-source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeLocalSessionSource } from "./local-session-source.js";

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ENROLLMENT = {
  enrollmentId: "enroll-1",
  agentId: "agent-1",
  requester: { profileId: "p1", displayName: "Ann" },
  audienceLabel: "Team",
};

type Frame =
  | { type: "session"; frame: Parameters<LocalSessionSourceHost["publishSession"]>[0] }
  | {
      type: "records";
      threadId: string;
      records: Parameters<LocalSessionSourceHost["publishRecords"]>[1];
    }
  | { type: "turn"; turn: Parameters<LocalSessionSourceHost["publishTurn"]>[0] }
  | { type: "inputResult"; result: Parameters<LocalSessionSourceHost["reportInput"]>[0] };

function createHost(signal: AbortSignal) {
  const frames: Frame[] = [];
  const host: LocalSessionSourceHost = {
    signal,
    publishSession: async (frame) => void frames.push({ type: "session", frame }),
    publishRecords: async (threadId, records) =>
      void frames.push({ type: "records", threadId, records }),
    publishDelta: async () => {},
    publishTurn: async (turn) => void frames.push({ type: "turn", turn }),
    reportInput: async (result) => void frames.push({ type: "inputResult", result }),
  };
  return { host, frames };
}

function transcriptLine(record: Record<string, unknown>, cwd: string): string {
  return `${JSON.stringify({
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    isSidechain: false,
    entrypoint: "cli",
    cwd,
    version: "2.1.197",
    ...record,
  })}\n`;
}

const waitFor = <T>(probe: () => T | Promise<T>) =>
  vi.waitFor(probe, { timeout: 4_000, interval: 25 });

describe("createClaudeLocalSessionSource", () => {
  let home: string;
  let workspace: string;
  let transcript: string;
  let endpoint: string;
  let abort: AbortController;
  let session: LocalSessionSourceSession | undefined;
  const clients: net.Socket[] = [];

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claude-src-")));
    workspace = path.join(home, "work");
    const projectDir = path.join(home, ".claude", "projects", "-work");
    await fs.mkdir(projectDir, { recursive: true });
    transcript = path.join(projectDir, `${SESSION_ID}.jsonl`);
    await fs.writeFile(
      transcript,
      transcriptLine({ type: "custom-title", customTitle: "Fix the build" }, workspace) +
        transcriptLine(
          { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
          workspace,
        ) +
        transcriptLine(
          {
            type: "assistant",
            uuid: "a1",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              stop_reason: "end_turn",
            },
          },
          workspace,
        ),
    );
    // macOS caps unix socket paths at 104 bytes; keep it out of the deep temp home.
    endpoint = path.join(os.tmpdir(), `oc-${randomBytes(4).toString("hex")}.sock`);
    abort = new AbortController();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.destroy();
    }
    await session?.stop();
    session = undefined;
    abort.abort();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(endpoint, { force: true });
  });

  async function start(cursors: Record<string, number> = {}, excluded: string[] = []) {
    const { host, frames } = createHost(abort.signal);
    const definition = createClaudeLocalSessionSource({
      homeDir: home,
      scanOptions: { includeDesktop: false },
      bridgeEndpoint: endpoint,
      hostLabel: "test-host",
      tickMs: 25,
      backstopMs: 200,
    });
    session = await definition.start(host, {
      enrollment: ENROLLMENT,
      cursors,
      excludedThreadIds: new Set(excluded),
      signal: abort.signal,
    });
    // Only a running Claude session is shared; announce it the way Claude's hook does.
    // The ancestry never matches a channel, so pairing stays with each test.
    await sendHook("SessionStart", workspace, [999_999]);
    if (!excluded.includes(SESSION_ID)) {
      await waitFor(() => expect(frames.some((frame) => frame.type === "session")).toBe(true));
    }
    return { frames, definition };
  }

  function connectChannel(cwd: string, ppid = 1): Promise<{ socket: net.Socket; lines: string[] }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      const lines: string[] = [];
      let buffered = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          lines.push(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
        }
      });
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ type: "hello", cwd, pid: 1, ppid })}\n`);
        clients.push(socket);
        resolve({ socket, lines });
      });
    });
  }

  function sendHook(event: string, cwd: string, ancestorPids: number[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.end(
          `${JSON.stringify({ type: "hook", event, sessionId: SESSION_ID, cwd, ancestorPids })}\n`,
        );
      });
      socket.on("close", () => resolve());
    });
  }

  it("declares the Claude source contract", () => {
    const definition = createClaudeLocalSessionSource({ hostLabel: "h" });
    expect(definition).toMatchObject({
      id: "claude",
      command: "anthropic.claude.localSessions.source.v1",
      hostLabel: "h",
      inputModes: ["followup"],
    });
    expect(definition.isAvailable?.({ env: { HOME: home }, config: {} })).toBe(true);
    expect(definition.isAvailable?.({ env: { HOME: path.join(home, "none") }, config: {} })).toBe(
      false,
    );
  });

  it("bootstraps sessions, tails new records with turn boundaries, and closes removed transcripts", async () => {
    const { frames } = await start();
    expect(frames[0]).toMatchObject({
      type: "session",
      frame: {
        threadId: SESSION_ID,
        state: "active",
        canInput: false,
        title: "Fix the build",
        cwd: workspace,
        reason: expect.stringContaining("openclaw channel"),
      },
    });
    expect(frames[1]).toMatchObject({
      type: "records",
      records: [
        { id: "u1", seq: 1, kind: "user", text: "hello" },
        { id: "a1", seq: 2, kind: "assistant", text: "hi" },
      ],
    });
    await fs.appendFile(
      transcript,
      transcriptLine(
        { type: "user", uuid: "u2", message: { role: "user", content: "next" } },
        workspace,
      ) +
        transcriptLine(
          {
            type: "assistant",
            uuid: "a2",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
              stop_reason: "tool_use",
            },
          },
          workspace,
        ) +
        transcriptLine(
          {
            type: "assistant",
            uuid: "a3",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              stop_reason: "end_turn",
            },
          },
          workspace,
        ),
    );
    await waitFor(() => expect(frames.filter((f) => f.type === "turn")).toHaveLength(2));
    const live = frames.slice(2);
    expect(live).toEqual([
      { type: "turn", turn: { threadId: SESSION_ID, turnId: "u2", state: "started" } },
      {
        type: "records",
        threadId: SESSION_ID,
        records: [
          expect.objectContaining({ id: "u2", seq: 3, kind: "user", turnId: "u2" }),
          expect.objectContaining({
            id: "a2",
            seq: 4,
            kind: "toolCall",
            toolName: "Bash",
            turnId: "u2",
          }),
          expect.objectContaining({ id: "a3", seq: 5, kind: "assistant", turnId: "u2" }),
        ],
      },
      { type: "turn", turn: { threadId: SESSION_ID, turnId: "u2", state: "completed" } },
    ]);
    await fs.rm(transcript);
    await waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: "session",
        frame: { threadId: SESSION_ID, state: "closed", reason: "transcript removed" },
      }),
    );
  });

  it("replays only past the resume cursor and honors excluded threads", async () => {
    const { frames } = await start({ [SESSION_ID]: 1 });
    expect(frames[0]).toMatchObject({
      type: "session",
      frame: { threadId: SESSION_ID, earliestSeq: 2 },
    });
    expect(frames[1]).toMatchObject({ type: "records", records: [{ id: "a1", seq: 2 }] });
    await session?.stop();
    const excludedRun = await start({}, [SESSION_ID]);
    expect(excludedRun.frames).toEqual([]);
  });

  it("rejects input without a channel, submits through a paired channel, and unshares", async () => {
    const { frames } = await start();
    const submit = (inputId: string, mode: "followup" | "steer" = "followup") =>
      session?.submitInput({
        type: "input",
        inputId,
        threadId: SESSION_ID,
        mode,
        text: "please run the tests",
        sender: { profileId: "p2", displayName: "Bob" },
      });
    await submit("in-1");
    expect(frames.at(-1)).toMatchObject({
      type: "inputResult",
      result: {
        inputId: "in-1",
        outcome: "rejected",
        reason: expect.stringContaining("openclaw channel"),
      },
    });

    const channel = await connectChannel(workspace);
    await sendHook("SessionStart", workspace);
    await waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: "session",
        frame: { threadId: SESSION_ID, canInput: true },
      }),
    );
    expect(frames.at(-1)).not.toHaveProperty("frame.reason");

    await submit("in-2", "steer");
    expect(frames.at(-1)).toMatchObject({
      type: "inputResult",
      result: { inputId: "in-2", outcome: "rejected" },
    });

    const pending = submit("in-3");
    await waitFor(() => expect(channel.lines).toHaveLength(1));
    const delivered = JSON.parse(channel.lines[0] ?? "{}") as Record<string, unknown>;
    expect(delivered).toMatchObject({
      type: "input",
      inputId: "in-3",
      sessionId: SESSION_ID,
      content: expect.stringContaining("[Bob via OpenClaw team"),
      meta: { sender: "Bob", openclaw_input_id: "in-3" },
    });
    channel.socket.write(`${JSON.stringify({ type: "delivered", inputId: "in-3" })}\n`);
    await pending;
    expect(frames.at(-1)).toMatchObject({
      type: "inputResult",
      result: { inputId: "in-3", outcome: "submitted", nativeRef: "in-3" },
    });

    channel.socket.destroy();
    await waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: "session",
        frame: { threadId: SESSION_ID, canInput: false },
      }),
    );

    session?.unshare(SESSION_ID);
    await waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: "session",
        frame: { threadId: SESSION_ID, state: "closed", canInput: false, reason: "unshared" },
      }),
    );
    await submit("in-4");
    expect(frames.at(-1)).toMatchObject({
      type: "inputResult",
      result: { inputId: "in-4", outcome: "rejected" },
    });
  });

  it("pairs by the shared Claude process, not by whichever channel shares the cwd", async () => {
    const { frames } = await start();
    // Two Claude sessions in one directory: the newest channel belongs to another session.
    const mine = await connectChannel(workspace, 4242);
    const other = await connectChannel(workspace, 5151);
    await sendHook("SessionStart", workspace, [9000, 4242, 1]);
    await waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: "session",
        frame: { threadId: SESSION_ID, canInput: true },
      }),
    );
    const pending = session?.submitInput({
      type: "input",
      inputId: "in-pid",
      threadId: SESSION_ID,
      mode: "followup",
      text: "which one are you",
      sender: { displayName: "Bob" },
    });
    await waitFor(() => expect(mine.lines).toHaveLength(1));
    expect(mine.lines[0]).toContain('"inputId":"in-pid"');
    expect(other.lines).toEqual([]);
    mine.socket.write(`${JSON.stringify({ type: "delivered", inputId: "in-pid" })}\n`);
    await pending;
    mine.socket.destroy();
    other.socket.destroy();
  });

  it("leaves a cwd-only hook unpaired while two channels share the directory", async () => {
    const { frames } = await start();
    const first = await connectChannel(workspace);
    const second = await connectChannel(workspace);
    await sendHook("SessionStart", workspace);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });
    // The transcript alone publishes the thread without input; no channel was bound.
    expect(frames.some((frame) => frame.type === "session" && frame.frame.canInput)).toBe(false);
    // Once the ambiguity is gone the next hook pairs the remaining channel.
    second.socket.destroy();
    await sendHook("UserPromptSubmit", workspace);
    await waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: "session",
        frame: { threadId: SESSION_ID, canInput: true },
      }),
    );
    first.socket.destroy();
  });

  it("closes an ended session, frees its slot, and re-admits it on the next start", async () => {
    const { frames } = await start();
    await sendHook("SessionEnd", workspace, [999_999]);
    await waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: "session",
        frame: { threadId: SESSION_ID, state: "closed", reason: "session ended" },
      }),
    );
    const before = frames.length;
    await sendHook("SessionStart", workspace, [999_999]);
    await waitFor(() => expect(frames.length).toBeGreaterThan(before));
    const readmitted = frames.findLast((frame) => frame.type === "session");
    expect(readmitted).toMatchObject({ frame: { threadId: SESSION_ID, canInput: false } });
    expect(readmitted).not.toMatchObject({ frame: { state: "closed" } });
  });

  it("pairs a channel that connects after the SessionStart hook", async () => {
    const { frames } = await start();
    await sendHook("SessionStart", workspace);
    const channel = await connectChannel(workspace);
    await waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: "session",
        frame: { threadId: SESSION_ID, canInput: true },
      }),
    );
    channel.socket.destroy();
  });
});
