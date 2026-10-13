import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { runBeforeAgentReplyForTurn } from "../../plugins/before-agent-reply.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { buildEmbeddedAgentHookContext } from "../embedded-agent-runner/run/agent-hook-context.js";
import { buildAgentHookContext } from "../harness/hook-context.js";
import { runCliBeforeAgentReply } from "./before-agent-reply.js";

afterEach(() => resetGlobalHookRunner());

describe("registered plugin causal hook metadata", () => {
  it.each([true, false, undefined])(
    "delivers admitted ownership %s through CLI and embedded hooks",
    async (senderIsOwner) => {
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({
        id: "causal-hook-proof",
        source: "test",
        origin: "bundled",
        enabled: true,
        configSchema: true,
      });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, { config: {} });
      const observed: Array<Pick<PluginHookAgentContext, "messageId" | "senderIsOwner">> = [];
      api.on("before_agent_reply", (_event, context) => {
        observed.push({ messageId: context.messageId, senderIsOwner: context.senderIsOwner });
        return { handled: true, reply: { text: "registered hook received the source" } };
      });
      initializeGlobalHookRunner(builder.registry);
      const base = {
        sessionId: "synthetic-session",
        sessionKey: "agent:main:googlechat:group:synthetic-chat",
        workspaceDir: "/synthetic/workspace",
        trigger: "user" as const,
        senderId: "synthetic-sender",
        senderIsOwner,
        causalMessageId: "spaces/test/messages/inbound",
        currentMessageId: "spaces/test/threads/reply",
      };
      try {
        const cli = await runCliBeforeAgentReply({
          ...base,
          runId: randomUUID(),
          provider: "claude-cli",
          prompt: "synthetic input",
          timeoutMs: 1000,
        });
        expect(cli?.payloads).toEqual([{ text: "registered hook received the source" }]);
        const embeddedRun = { ...base, runId: randomUUID() };
        const embedded = buildEmbeddedAgentHookContext(embeddedRun, "main", undefined);
        await runBeforeAgentReplyForTurn({
          runId: embeddedRun.runId,
          trigger: "user",
          event: { cleanedBody: "synthetic input" },
          context: buildAgentHookContext(embedded),
        });
        expect(observed).toEqual(
          Array.from({ length: 2 }, () => ({ messageId: base.causalMessageId, senderIsOwner })),
        );

        await runCliBeforeAgentReply({
          ...base,
          runId: randomUUID(),
          provider: "claude-cli",
          prompt: "synthetic internal input",
          timeoutMs: 1000,
          inputProvenance: { kind: "internal_system" },
        });
        expect(observed.at(-1)).toEqual({ messageId: undefined, senderIsOwner: undefined });
      } finally {
        await getPluginInstance(record)?.dispose();
      }
    },
  );
});
