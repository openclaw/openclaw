import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as loggingConfigModule from "../../logging/config.js";
import { redactSensitiveFieldValueWithConfig } from "../../logging/redact.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawAgentDatabases,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { extractToolResultText, sanitizeToolResult } from "../embedded-agent-tool-results.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { redactTranscriptMessage } from "../transcript-redact.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = createTempDirTracker();
afterEach(() => {
  resetSecretRedactionRegistryForTest();
  vi.restoreAllMocks();
  for (const dir of tempDirs.dirs) {
    closeOpenClawAgentDatabasesForTest(dir);
  }
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function appendLookup(manager: SessionManager, id: string, payload: Record<string, unknown>) {
  const text = expectDefined(
    extractToolResultText(sanitizeToolResult({ type: "json", ...payload })),
    "model-visible lookup output",
  );
  manager.appendMessage(
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id, name: "lookup_resource", arguments: { name: "fixture" } }],
      stopReason: "toolUse",
    }),
  );
  manager.appendMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "lookup_resource",
    content: [{ type: "text", text }],
    details: payload,
    isError: false,
    timestamp: 1,
  });
  manager.flushPendingPersistence();
  return text;
}

function readReplayedReference(manager: SessionManager, id: string): string {
  const message = manager
    .buildSessionContext()
    .messages.find((entry) => entry.role === "toolResult" && entry.toolCallId === id);
  if (!message || message.role !== "toolResult") {
    throw new Error("Reloaded lookup result is missing");
  }
  const content = message.content.find((block) => block.type === "text");
  if (!content || content.type !== "text") {
    throw new Error("Reloaded lookup text is missing");
  }
  const payload = asOptionalRecord(JSON.parse(content.text));
  if (typeof payload?.doc_token !== "string") {
    throw new Error("Reloaded lookup has no string resource reference");
  }
  return payload.doc_token;
}

it.each([false, true])(
  "reuses a resource after SQLite session reload (existing masked history: %s)",
  async (existingHistory) => {
    const dir = tempDirs.make("openclaw-resource-replay-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
      const reference = "SyntheticResourceIdentifier1234567890";
      const credential = "SyntheticOpaqueCredential1234567890";
      const registered = "SyntheticRegisteredSecret1234567890";
      const custom = "SyntheticCustomSecret1234567890";
      const recognized = `sk-${"SYNTHETIC".repeat(8)}`;
      const logging = { redactPatterns: [custom] };
      vi.spyOn(loggingConfigModule, "readLoggingConfig").mockReturnValue(logging);
      const target = {
        agentId: "main",
        sessionId: "resource-replay",
        sessionKey: "agent:main:resource-replay",
        storePath: path.join(dir, "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      // A local file fixture is addressed by the supplied identifier.
      writeFileSync(path.join(dir, `${reference}.txt`), "RESOURCE_READ_OK", "utf8");
      const readResource = (docToken: string) =>
        readFileSync(path.join(dir, `${docToken}.txt`), "utf8");
      const legacyMask = redactSensitiveFieldValueWithConfig("doc_token", reference, logging);
      if (existingHistory) {
        appendLookup(SessionManager.open(target, dir), "legacy", { doc_token: legacyMask });
        const restored = readReplayedReference(SessionManager.open(target, dir), "legacy");
        expect(restored).toBe(legacyMask);
        expect(() => readResource(restored)).toThrow();
      }

      registerSecretValueForRedaction(registered);
      const manager = SessionManager.open(target, dir);
      installSessionToolResultGuard(manager, {
        transformMessageForPersistence: (message) => redactTranscriptMessage(message, { logging }),
        redactLoggingConfig: logging,
      });
      // An explicit fresh lookup supplies the reference; no historical mask is decoded.
      const visible = appendLookup(manager, "fresh", {
        doc_token: reference,
        access_token: { doc_token: credential },
        registered: { doc_token: registered },
        custom: { doc_token: custom },
        recognized: { doc_token: recognized },
      });
      expect(visible).toContain(reference);
      // Release the connection so the next manager must reload durable SQLite state.
      closeOpenClawAgentDatabases(dir);
      const reopened = SessionManager.open(target, dir);
      const replayed = readReplayedReference(reopened, "fresh");
      expect(readResource(replayed)).toBe("RESOURCE_READ_OK");
      installSessionToolResultGuard(reopened, {
        transformMessageForPersistence: (message) => redactTranscriptMessage(message, { logging }),
        redactLoggingConfig: logging,
      });
      reopened.appendMessage(
        makeAgentAssistantMessage({
          content: [
            {
              type: "toolCall",
              id: "read",
              name: "read_resource",
              arguments: { doc_token: replayed },
            },
          ],
          stopReason: "toolUse",
        }),
      );
      reopened.appendMessage({
        role: "toolResult",
        toolCallId: "read",
        toolName: "read_resource",
        content: [{ type: "text", text: readResource(replayed) }],
        isError: false,
        timestamp: 2,
      });
      reopened.flushPendingPersistence();
      closeOpenClawAgentDatabases(dir);
      const final = SessionManager.open(target, dir);
      const context = final.buildSessionContext().messages;
      expect(context).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({
              type: "toolCall",
              name: "read_resource",
              arguments: { doc_token: reference },
            }),
          ],
        }),
      );
      expect(context).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolName: "read_resource",
          content: [{ type: "text", text: "RESOURCE_READ_OK" }],
        }),
      );
      const persisted = JSON.stringify(loadTranscriptEventsSync(target));
      for (const secret of [credential, registered, custom, recognized]) {
        expect(visible).not.toContain(secret);
        expect(persisted).not.toContain(secret);
        expect(JSON.stringify(context)).not.toContain(secret);
      }
      if (existingHistory) {
        expect(readReplayedReference(final, "legacy")).toBe(legacyMask);
      }
    });
  },
);
