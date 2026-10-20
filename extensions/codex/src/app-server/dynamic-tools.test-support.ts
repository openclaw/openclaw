import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";

export function throwingResultObserver() {
  const error = Object.defineProperty(new Error(), "message", {
    get() {
      throw new Error("observer message getter escaped");
    },
  });
  const onAgentToolResult = vi.fn(() => {
    throw error;
  });
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
  warn.mockClear();
  return { onAgentToolResult, warn };
}

export function mediaResult(mediaUrl: string, audioAsVoice?: boolean): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: "Generated media reply." }],
    details: {
      media: {
        mediaUrl,
        ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
      },
    },
  };
}

export function textToolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

export function installResultMiddleware(
  handler: ReturnType<
    typeof createEmptyPluginRegistry
  >["agentToolResultMiddlewares"][number]["handler"],
) {
  const registry = createEmptyPluginRegistry();
  registry.agentToolResultMiddlewares.push({
    pluginId: "test-result",
    pluginName: "Test result",
    rawHandler: handler,
    handler,
    runtimes: ["codex"],
    source: "test",
  });
  setActivePluginRegistry(registry);
}
