import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createFileAcpEventLedger, createInMemoryAcpEventLedger } from "./event-ledger.js";

describe("ACP event ledger", () => {
  it("records complete in-memory session updates in sequence", async () => {
    const ledger = createInMemoryAcpEventLedger({ now: () => 123 });
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUserPrompt({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      runId: "run-1",
      prompt: [{ type: "text", text: "Question" }],
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      runId: "run-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      },
    });

    const replay = await ledger.readReplay({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
    });

    expect(replay.complete).toBe(true);
    expect(replay.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(replay.events.map((event) => event.runId)).toEqual(["run-1", "run-1"]);
    expect(replay.events.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
  });

  it("marks a session incomplete when event retention truncates history", async () => {
    const ledger = createInMemoryAcpEventLedger({ maxEventsPerSession: 1 });
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First" },
      },
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Second" },
      },
    });

    await expect(
      ledger.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
    ).resolves.toEqual({ complete: false, events: [] });
  });

  it("persists file-backed replay state across ledger instances", async () => {
    await withTempDir({ prefix: "openclaw-acp-ledger-" }, async (dir) => {
      const filePath = path.join(dir, "acp", "event-ledger.json");
      const first = createFileAcpEventLedger({ filePath, now: () => 1000 });
      await first.startSession({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        cwd: "/work",
        complete: true,
      });
      await first.recordUpdate({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        runId: "run-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thinking" },
        },
      });

      const second = createFileAcpEventLedger({ filePath });
      const replay = await second.readReplay({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
      });

      expect(replay.complete).toBe(true);
      expect(replay.events).toHaveLength(1);
      expect(replay.events[0]?.update).toEqual({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking" },
      });
      await expect(fs.readFile(filePath, "utf8")).resolves.toContain('"version": 1');
    });
  });

  it("ignores corrupt ledger files instead of replaying unknown state", async () => {
    await withTempDir({ prefix: "openclaw-acp-ledger-" }, async (dir) => {
      const filePath = path.join(dir, "event-ledger.json");
      await fs.writeFile(filePath, "{bad json", "utf8");
      const ledger = createFileAcpEventLedger({ filePath });

      await expect(
        ledger.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
      ).resolves.toEqual({ complete: false, events: [] });
    });
  });
});
