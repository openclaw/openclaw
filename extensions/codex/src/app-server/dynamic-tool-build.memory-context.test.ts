import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";

const {
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  setupDynamicToolBuildFixture,
  createCodexRuntimePlanFixture,
  createParams,
} = await import("./dynamic-tool-build.test-support.js");

let tempDir: string;
let workspaceDir: string;
let params: EmbeddedRunAttemptParamsV2;

beforeEach(async () => {
  tempDir = await setupDynamicToolBuildFixture();
  workspaceDir = path.join(tempDir, "workspace");
  params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir, {
    disableTools: false,
    runtimePlan: createCodexRuntimePlanFixture(),
  });
});

afterEach(async () => {
  await cleanupDynamicToolBuildFixture(tempDir, []);
});

it.each([
  { separateToolStore: false, corpus: undefined },
  { separateToolStore: false, corpus: "sessions" },
  { separateToolStore: true, corpus: "configured" },
] as const)(
  "forwards memory/auth context: separate store=$separateToolStore, recall corpus=$corpus",
  async ({ separateToolStore, corpus }) => {
    const oauthProfile = {
      provider: "openai",
      type: "oauth",
      access: "transport-token",
      refresh: "transport-refresh",
      expires: 4_000_000_000_000,
    } as const;
    params.authProfileStore = {
      version: 1,
      profiles: separateToolStore
        ? { "openai:work": oauthProfile }
        : {
            "openai:api-key-backup": {
              provider: "openai",
              type: "api_key",
              key: "not-a-real-key",
            },
          },
    };
    params.toolAuthProfileStore = separateToolStore ? { ...params.authProfileStore } : undefined;
    params.messageActionTurnCapability = "turn-capability-1";
    params.senderIsOwner = true;
    params.memoryAudience = Object.freeze({
      kind: "conversation",
      agentId: "main",
      sessionKey: expectDefined(params.sessionKey, "memory audience session key"),
      sessionId: params.sessionId,
    });
    params.conversationRecall = corpus
      ? Object.freeze({
          anchorSessionKey: expectDefined(params.sessionKey, "recall anchor session key"),
          scope: "same-agent-private",
          corpus,
        })
      : undefined;
    const factory = vi.fn((_options: Parameters<typeof createOpenClawCodingTools>[0]) => []);
    setCodexTestToolFactory(params, factory);

    await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null });

    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[0]?.memoryAudience).toBe(params.memoryAudience);
    expect(factory.mock.calls[0]?.[0]?.conversationRecall).toBe(params.conversationRecall);
    expect(factory.mock.calls[0]?.[0]?.authProfileStore).toBe(
      params.toolAuthProfileStore ?? params.authProfileStore,
    );
    expect(factory.mock.calls[0]?.[0]?.messageActionTurnCapability).toBe("turn-capability-1");
  },
);
