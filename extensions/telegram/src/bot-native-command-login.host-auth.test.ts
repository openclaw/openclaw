import {
  createEmptyPluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loginSessionMocks,
  resetLoginCommandMocks,
} from "./bot-native-command-login.session-test-support.js";
import {
  createOwnerLoginConfig,
  registerLoginCommand,
} from "./bot-native-command-login.test-support.js";
import { createPrivateCommandContext } from "./bot-native-commands.menu-test-support.js";

describe("registerTelegramNativeCommands host-managed /login", () => {
  beforeEach(resetLoginCommandMocks);

  it.each(["", "refresh", "codex", "oauth/openai/openai"])(
    "refuses native /login %s for a host-owned model without starting a flow",
    async (match) => {
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "host-runtime",
        source: "test",
        harness: {
          id: "host-runtime",
          label: "Host runtime",
          supports: ({ provider }) =>
            provider === "openai" ? { supported: true } : { supported: false },
          resolveAuthOwnership: ({ provider }) => (provider === "openai" ? "host" : undefined),
          runAttempt: async () => {
            throw new Error("Login command must not execute a turn");
          },
        },
      });
      const loginFlow = vi.fn();
      const cfg: OpenClawConfig = {
        ...createOwnerLoginConfig(),
        agents: { defaults: { model: "openai/test-model" } },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "host-runtime" },
              models: [],
            },
          },
        },
      };
      const { handler, sendMessage } = registerLoginCommand({ cfg, loginFlow, registry });
      await withPluginRuntimeRegistryScope(registry, () =>
        handler(createPrivateCommandContext({ match, userId: 200 })),
      );
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "Authentication is managed by the app-server host. OpenClaw cannot start a login or replace its credentials. The host is responsible for obtaining and refreshing authentication.",
        expect.anything(),
      );
      expect(loginFlow).not.toHaveBeenCalled();
      expect(loginSessionMocks.patchSessionEntry).not.toHaveBeenCalled();
    },
  );
});
