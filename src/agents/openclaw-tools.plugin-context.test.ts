/**
 * Regression coverage for plugin tool context and delivery metadata.
 * Verifies requester metadata, workspace selection, and delivery routing.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveOpenClawPluginToolInputs,
  type OpenClawPluginToolOptions,
} from "./openclaw-tools.plugin-context.js";

function resolve(options: OpenClawPluginToolOptions) {
  return resolveOpenClawPluginToolInputs({ options: { config: {}, ...options } });
}

describe("openclaw plugin tool context", () => {
  it("forwards runtime-owned active model metadata", () => {
    const result = resolve({
      modelProvider: " local-provider ",
      modelId: " local-model ",
    });

    expect(result.context.activeModel).toStrictEqual({
      provider: "local-provider",
      modelId: "local-model",
      modelRef: "local-provider/local-model",
    });
  });

  it("does not duplicate provider-qualified active model refs", () => {
    const result = resolve({
      modelProvider: "openrouter",
      modelId: "openrouter/auto",
    });

    expect(result.context.activeModel).toStrictEqual({
      provider: "openrouter",
      modelId: "openrouter/auto",
      modelRef: "openrouter/auto",
    });
  });

  it("uses requester agent override for synthetic embedded session keys", () => {
    const recallWorkspace = path.join(process.cwd(), "tmp-recall-workspace");
    const config = {
      agents: {
        defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
        list: [
          { id: "main", default: true },
          { id: "recall", workspace: recallWorkspace },
        ],
      },
    } as never;
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config,
        agentSessionKey: "explicit:user-session:active-memory:abc123",
        requesterAgentIdOverride: "recall",
      },
      resolvedConfig: config,
    });

    expect(result.context.agentId).toBe("recall");
    expect(result.context.workspaceDir).toBe(recallWorkspace);
  });

  it("keeps the routable conversation target ahead of the native channel id", () => {
    const result = resolve({
      agentChannel: "slack",
      currentMessagingTarget: "user:U123",
      currentChannelId: "D123",
    });

    expect(result.context.deliveryContext?.to).toBe("user:U123");
  });
});
