import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayScopedTools } from "../gateway/tool-resolution.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("scheduled message invocation admission", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => clearRuntimeConfigSnapshot());

  it.each(["embedded", "loopback"] as const)(
    "%s applies a published model policy for the borrowed owner to the next invocation",
    (surface) => {
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        tools: { profile: "full" },
        agents: {
          ownership: "explicit",
          entries: {
            main: { tools: { deny: ["message"] } },
            reader: { tools: { profile: "full" } },
          },
        },
      };
      setRuntimeConfigSnapshot(config, config);
      const run = {
        agentId: "main",
        modelProvider: "anthropic",
        modelId: "scheduled-test-model",
        messageActionTurnCapability: "host-turn-capability",
        scheduledToolPolicy: { version: 1, mode: "trusted" } as const,
      };
      const tools =
        surface === "embedded"
          ? createOpenClawCodingTools({
              ...run,
              config,
              policyAgentId: "reader",
              sessionKey: "agent:reader:cron:policy",
              runSessionKey: "agent:main:cron:execution",
              runtimeToolAllowlist: ["message"],
            })
          : resolveGatewayScopedTools({
              ...run,
              cfg: config,
              surface: "loopback",
              sessionKey: "agent:main:cron:execution",
              runtimePolicyAgentId: "reader",
              runtimePolicySessionKey: "agent:reader:cron:policy",
              gatewayRequestedTools: ["message"],
              disablePluginTools: true,
            }).tools;
      expect(tools.some((tool) => tool.name === "message")).toBe(true);
      const factoryOptions = vi.mocked(createOpenClawTools).mock.calls.at(-1)?.[0];
      const admit = expectDefined(
        factoryOptions?.admitScheduledMessageInvocation,
        "scheduled factory admission",
      );
      const acceptedConfig = admit();

      const narrowed: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          entries: {
            ...config.agents?.entries,
            reader: {
              tools: {
                profile: "full",
                byProvider: { "anthropic/scheduled-test-model": { deny: ["message"] } },
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(narrowed, narrowed);
      expect(admit).toThrow(/not allowed by the current tool policy/);
      expect(acceptedConfig).toBe(config);

      setRuntimeConfigSnapshot(config, config);
      expect(admit()).toBe(config);
      expect(createOpenClawTools).toHaveBeenCalledTimes(1);
    },
  );
});
