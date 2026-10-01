import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRecentSessionTranscriptActiveEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readSessionForkReplySelectionInWorker } from "../config/sessions/session-transcript-read-worker-runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { attachNativeInboundTransportForPersistence } from "./embedded-agent-runner/run/inbound-transport-persistence.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

const isolatedRoot = path.resolve(import.meta.dirname, "../../.artifacts/gate-a-isolated");

describe("durable native inbound transport origin", () => {
  const priorEnv = captureEnv(["OPENCLAW_STATE_DIR"]);
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    priorEnv.restore();
  });

  it("reads an exact native ID and chat scope back from the SQLite active transcript", async () => {
    const dir = path.join(isolatedRoot, "transcript", randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    setTestEnvValue("OPENCLAW_STATE_DIR", dir);
    const target = {
      agentId: "main",
      sessionId: randomUUID(),
      sessionKey: "agent:main:provenance-fixture",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: Date.now() });
    const transport = {
      messageId: "91",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001:topic:42",
        parentConversationId: "-1001",
      },
    };
    const manager = guardSessionManager(SessionManager.open(target, dir), {
      onUserMessagePreparedForPersistence: (message) =>
        attachNativeInboundTransportForPersistence(message, transport),
    });
    const userMessage: {
      role: "user";
      content: string;
      timestamp: number;
      __openclaw: { transport: { conversationRef: string } };
    } = {
      role: "user",
      content: "a verified inbound message",
      timestamp: 1,
      __openclaw: { transport: { conversationRef: "conv_synthetic" } },
    };
    manager.appendMessage(userMessage);
    manager.flushPendingPersistence();
    const events = readRecentSessionTranscriptActiveEvents(target, 10);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "user",
            __openclaw: {
              transport: { conversationRef: "conv_synthetic", ...transport },
            },
            content: "a verified inbound message",
          }),
        }),
      ]),
    );
    expect(events.at(-1)).not.toHaveProperty("message.transport");
    await expect(
      readSessionForkReplySelectionInWorker({
        target,
        replyToId: "91",
        conversation: transport.conversation,
      }),
    ).resolves.toEqual({
      status: "found",
      entryId: expect.any(String),
      text: "a verified inbound message",
    });
    await expect(
      readSessionForkReplySelectionInWorker({
        target,
        replyToId: "91",
        conversation: { ...transport.conversation, conversationId: "other-topic" },
      }),
    ).resolves.toEqual({ status: "missing" });
  });
});
