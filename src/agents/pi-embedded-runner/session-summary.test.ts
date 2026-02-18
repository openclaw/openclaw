import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSessionSummaryPrompt,
  getSessionSummaryStatePath,
  loadSessionSummaryState,
  persistSessionSummaryState,
  updateSessionSummaryState,
} from "./session-summary.js";

function makeMessage(role: "user" | "assistant", text: string): AgentMessage {
  if (role === "user") {
    return {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    } as AgentMessage;
  }
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as AgentMessage;
}

describe("session summary state", () => {
  it("loads empty state when file is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-summary-state-"));
    const sessionFile = path.join(dir, "session.jsonl");

    const state = await loadSessionSummaryState({ sessionFile });
    expect(state.items).toEqual([]);
    expect(state.lastProcessedMessageCount).toBe(0);
  });

  it("updates state from new user/assistant messages only", () => {
    const messages: AgentMessage[] = [
      makeMessage("user", "first"),
      makeMessage("assistant", "second"),
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: "ignored" }],
        isError: false,
        timestamp: Date.now(),
      },
      makeMessage("assistant", "third"),
    ];

    const updated = updateSessionSummaryState({
      state: {
        version: 1,
        lastProcessedMessageCount: 0,
        items: [],
        updatedAt: Date.now(),
      },
      messages,
      maxItems: 10,
    });

    expect(updated.items).toEqual(["User: first", "Assistant: second", "Assistant: third"]);
    expect(updated.lastProcessedMessageCount).toBe(messages.length);
  });

  it("skips synthetic session summary messages", () => {
    const updated = updateSessionSummaryState({
      state: {
        version: 1,
        lastProcessedMessageCount: 0,
        items: [],
        updatedAt: Date.now(),
      },
      messages: [
        makeMessage("user", "[SESSION_SUMMARY]\nUse this as compressed prior context."),
        makeMessage("assistant", "normal reply"),
      ],
      maxItems: 10,
    });

    expect(updated.items).toEqual(["Assistant: normal reply"]);
  });

  it("builds bounded prompt from most recent summary items", () => {
    const prompt = buildSessionSummaryPrompt({
      state: {
        version: 1,
        lastProcessedMessageCount: 10,
        items: [
          "User: old",
          "Assistant: old-reply",
          "User: latest request with details",
          "Assistant: latest response",
        ],
        updatedAt: Date.now(),
      },
      maxChars: 170,
    });

    expect(prompt).toBeTruthy();
    expect(prompt).toContain("[SESSION_SUMMARY]");
    expect(prompt).toContain("latest");
    expect(prompt?.length).toBeLessThanOrEqual(170);
  });

  it("resets summary tracking when transcript rewinds", () => {
    const rewound = updateSessionSummaryState({
      state: {
        version: 1,
        lastProcessedMessageCount: 10,
        items: ["User: stale", "Assistant: stale"],
        updatedAt: Date.now(),
      },
      messages: [makeMessage("user", "fresh start"), makeMessage("assistant", "fresh reply")],
      maxItems: 10,
    });

    expect(rewound.lastProcessedMessageCount).toBe(2);
    expect(rewound.items).toEqual(["User: fresh start", "Assistant: fresh reply"]);
  });

  it("persists and reloads summary state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-summary-roundtrip-"));
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf-8");

    await persistSessionSummaryState({
      sessionFile,
      state: {
        version: 1,
        lastProcessedMessageCount: 7,
        items: ["User: hello", "Assistant: world"],
        updatedAt: Date.now(),
      },
    });

    const loaded = await loadSessionSummaryState({ sessionFile });
    expect(loaded.items).toEqual(["User: hello", "Assistant: world"]);
    expect(loaded.lastProcessedMessageCount).toBe(7);

    const statePath = getSessionSummaryStatePath(sessionFile);
    await expect(fs.stat(statePath)).resolves.toBeTruthy();
  });
});
