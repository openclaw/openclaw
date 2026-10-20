import * as agentRuntime from "openclaw/plugin-sdk/agent-runtime";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  findCommandByNativeName,
  listNativeCommandSpecsForConfig,
} from "openclaw/plugin-sdk/native-command-registry";
import { PLUGIN_COMMAND_DISPATCH } from "openclaw/plugin-sdk/plugin-command-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi, type Mock } from "vitest";
import * as pickerPreferences from "./model-picker-preferences.js";
import * as pickerState from "./model-picker.state.js";
import { createModelsProviderData } from "./model-picker.test-utils.js";
import {
  createMockCommandInteraction as createInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";

export function createNativeDispatchConfig(): OpenClawConfig {
  return {
    channels: {
      discord: {
        dm: { enabled: true },
        dmPolicy: "open",
        allowFrom: ["*"],
      },
    },
  };
}

export type MockCalls = {
  mock: Pick<Mock["mock"], "calls">;
};
type RegistryRoutingFixture = {
  createNativeCommand: (
    cfg: OpenClawConfig,
    spec: NativeCommandSpec,
  ) => Promise<ReturnType<typeof import("./native-command.js").createDiscordNativeCommand>>;
  runtimeModuleMocks: {
    pluginCommandHandler: MockCalls;
    dispatchReplyWithDispatcher: MockCalls;
    resolveDirectStatusReplyForSession: MockCalls;
  };
  expectFollowUpFields: (
    interaction: MockCommandInteraction,
    expected: Record<string, unknown>,
  ) => Record<string, unknown>;
  requireRecord: (value: unknown, label: string) => Record<string, unknown>;
  firstMockArg: (mock: MockCalls, label: string) => unknown;
  expectSingleCallFirstArg: (
    mock: MockCalls,
    expected: Record<string, unknown>,
    label?: string,
  ) => Record<string, unknown>;
  expectFields: (record: Record<string, unknown>, expected: Record<string, unknown>) => void;
};

export function registerNativeRegistryRoutingCases({
  createNativeCommand,
  runtimeModuleMocks,
  expectFollowUpFields,
  requireRecord,
  firstMockArg,
  expectSingleCallFirstArg,
  expectFields,
}: RegistryRoutingFixture): void {
  it("routes the current native registry and a dynamic skill through the Discord adapter", async () => {
    // Adapter routing only: core execution, provider discovery and Discord transport are fixtures.
    // The real reply/cohort regression belongs to the core owner, not this mocked dispatcher.
    const state = await createOpenClawTestState({ label: "discord-native-registry-routing" });
    try {
      const cfg: OpenClawConfig = {
        ...createNativeDispatchConfig(),
        commands: { config: true, mcp: true, plugins: true, debug: true },
        agents: { defaults: { model: { primary: "openai/fixture-model" } } },
      };
      await state.writeConfig(cfg);
      vi.spyOn(agentRuntime, "loadPreparedModelCatalog").mockResolvedValue([]);
      const pickerCatalog = vi
        .spyOn(pickerState, "loadDiscordModelPickerData")
        .mockResolvedValue(createModelsProviderData({ openai: ["fixture-model"] }));
      vi.spyOn(pickerPreferences, "readDiscordModelPickerRecentModels").mockResolvedValue([]);
      const specs = listNativeCommandSpecsForConfig(cfg, {
        provider: "discord",
        includeBundledChannelFallback: false,
        skillCommands: [
          { name: "fixture-skill", skillName: "fixture-skill", description: "A dynamic skill" },
        ],
      });
      expect(specs.some((spec) => spec.name === "fixture-skill")).toBe(true);

      for (const spec of specs) {
        vi.clearAllMocks();
        const interaction = createInteraction();
        const command = await createNativeCommand(cfg, spec);
        const definition = findCommandByNativeName(spec.name, "discord", {
          includeBundledChannelFallback: false,
        });

        // Missing arguments are deliberate: retain the real menus and pickers instead of
        // manufacturing an argument that sends every command down the same reply branch.
        await command.run(interaction);

        expect(runtimeModuleMocks.pluginCommandHandler, spec.name).not.toHaveBeenCalled();
        const dispatch = runtimeModuleMocks.dispatchReplyWithDispatcher;
        const status = runtimeModuleMocks.resolveDirectStatusReplyForSession;
        if (definition?.key === "status") {
          expect(status, spec.name).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              sessionKey: "agent:main:discord:dm:owner",
              isAuthorizedSender: true,
            }),
          );
          expectFollowUpFields(interaction, { content: "status reply" });
          expect(dispatch, spec.name).not.toHaveBeenCalled();
          expect(pickerCatalog, spec.name).not.toHaveBeenCalled();
        } else if (definition?.key === "model" || definition?.key === "models") {
          expect(pickerCatalog, spec.name).toHaveBeenCalledExactlyOnceWith(cfg, "main", {
            sessionEntry: undefined,
          });
          expect(dispatch, spec.name).not.toHaveBeenCalled();
          expect(status, spec.name).not.toHaveBeenCalled();
          const payload = requireRecord(firstMockArg(interaction.followUp, spec.name), spec.name);
          expect(
            Array.isArray(payload.components) && payload.components.length > 0,
            spec.name,
          ).toBe(true);
        } else if (definition?.argsMenu && definition.argsParsing !== "none") {
          const payload = expectSingleCallFirstArg(
            interaction.followUp,
            { ephemeral: true },
            spec.name,
          );
          expect(
            Array.isArray(payload.components) && payload.components.length > 0,
            spec.name,
          ).toBe(true);
          expect(dispatch, spec.name).not.toHaveBeenCalled();
          expect(status, spec.name).not.toHaveBeenCalled();
          expect(pickerCatalog, spec.name).not.toHaveBeenCalled();
        } else {
          const dispatched = expectSingleCallFirstArg(dispatch, {}, spec.name);
          expectFields(requireRecord(dispatched.ctx, `${spec.name} context`), {
            SessionKey: "agent:main:discord:slash:owner",
            CommandTargetSessionKey: "agent:main:discord:dm:owner",
            CommandSource: "native",
            CommandAuthorized: true,
            commandText: `/${definition?.nativeName ?? spec.name}`,
          });
          const replyOptions = requireRecord(dispatched.replyOptions, `${spec.name} reply options`);
          expect(Reflect.get(replyOptions, PLUGIN_COMMAND_DISPATCH)).toEqual({
            kind: "non-plugin",
          });
          expect(status, spec.name).not.toHaveBeenCalled();
          expect(pickerCatalog, spec.name).not.toHaveBeenCalled();
        }
      }
    } finally {
      await state.cleanup();
    }
  });

  it("denies the current native registry before status, menus, or command effects", async () => {
    const cfg: OpenClawConfig = {
      ...createNativeDispatchConfig(),
      commands: {
        config: true,
        mcp: true,
        plugins: true,
        debug: true,
        allowFrom: { discord: ["user:allowed-sender"] },
      },
    };
    const catalog = vi.spyOn(agentRuntime, "loadPreparedModelCatalog");
    const pickerCatalog = vi.spyOn(pickerState, "loadDiscordModelPickerData");
    for (const spec of listNativeCommandSpecsForConfig(cfg, {
      provider: "discord",
      includeBundledChannelFallback: false,
      skillCommands: [
        { name: "fixture-skill", skillName: "fixture-skill", description: "A dynamic skill" },
      ],
    })) {
      vi.clearAllMocks();
      const interaction = createInteraction({ userId: "denied-sender" });
      const command = await createNativeCommand(cfg, spec);

      await command.run(interaction);

      expectFollowUpFields(interaction, {
        content: "You are not authorized to use this command.",
        ephemeral: true,
      });
      expect(runtimeModuleMocks.dispatchReplyWithDispatcher, spec.name).not.toHaveBeenCalled();
      expect(
        runtimeModuleMocks.resolveDirectStatusReplyForSession,
        spec.name,
      ).not.toHaveBeenCalled();
      expect(runtimeModuleMocks.pluginCommandHandler, spec.name).not.toHaveBeenCalled();
      expect(catalog, spec.name).not.toHaveBeenCalled();
      expect(pickerCatalog, spec.name).not.toHaveBeenCalled();
    }
  });
}
