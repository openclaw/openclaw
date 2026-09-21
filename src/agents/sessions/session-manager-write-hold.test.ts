import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../runtime/index.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import * as transcriptRedact from "../transcript-redact.js";
import { SessionManager } from "./session-manager.js";

it.each(["assistant", "toolResult"] as const)(
  "prepares large %s payloads before taking the SQLite writer lock",
  async (role) => {
    await withOpenClawTestState({ label: "session-write-hold" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "write-hold",
        sessionKey: "agent:main:write-hold",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(scope, state.workspaceDir);
      const parentId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
      const { db } = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        path: resolveSessionTranscriptDatabasePath(scope),
      });
      const text = "```ts\nconst value = 42;\n```\n".repeat(8000);
      const content = [{ type: "text" as const, text }];
      const message: AgentMessage =
        role === "assistant"
          ? {
              role,
              content,
              api: "messages",
              provider: "anthropic",
              model: "sonnet-4.6",
              usage: createZeroUsageFixture(),
              stopReason: "stop",
              timestamp: 2,
            }
          : { role, content, toolCallId: "call-1", toolName: "read", isError: false, timestamp: 2 };
      Object.assign(message, { MediaPaths: ["/media/a.png"], MediaTypes: ["image/png"] });
      const redactionHeld: boolean[] = [];
      const largeJsonHeld: boolean[] = [];
      const redact = transcriptRedact.redactTranscriptMessage;
      const stringify = JSON.stringify;
      const parse = JSON.parse;
      const spies = [
        vi.spyOn(transcriptRedact, "redactTranscriptMessage").mockImplementation((...args) => {
          redactionHeld.push(db.isTransaction);
          return redact(...args);
        }),
        vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof stringify>) => {
          const result = stringify(...args);
          if (result && result.length > 100_000) {
            largeJsonHeld.push(db.isTransaction);
          }
          return result;
        }),
        vi.spyOn(JSON, "parse").mockImplementation((...args: Parameters<typeof parse>) => {
          if (args[0].length > 100_000) {
            largeJsonHeld.push(db.isTransaction);
          }
          return parse(...args);
        }),
      ];
      let entryId: string;
      try {
        entryId = manager.appendMessage(message);
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
      expect(redactionHeld).toEqual([false]);
      expect(largeJsonHeld.length).toBeGreaterThan(0);
      expect(largeJsonHeld).not.toContain(true);
      const entry = manager.getEntry(entryId);
      expect(entry).toMatchObject({
        parentId,
        message: {
          role,
          content,
          __openclaw: { media: [{ path: "/media/a.png", contentType: "image/png" }] },
        },
      });
      if (entry?.type !== "message") {
        throw new Error("Missing committed message");
      }
      expect(entry.message).not.toHaveProperty("MediaPaths");
      expect(entry.message).not.toHaveProperty("MediaTypes");
      expect(loadTranscriptEventsSync(scope).at(-1)).toEqual(manager.getEntry(entryId));
    });
  },
);
