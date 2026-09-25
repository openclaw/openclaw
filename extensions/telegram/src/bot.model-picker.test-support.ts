import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { mockPublishedModelRuntimeForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { listSessionEntries } from "openclaw/plugin-sdk/session-store-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { createTelegramCallbackContext } from "./bot.test-helpers.js";
import type { TelegramBotOptions } from "./bot.types.js";

type Harness = typeof import("./bot.create-telegram-bot.test-harness.js");
const requireRecord = createRequireRecord("object", "expected-label");

export function registerTelegramModelPickerCases({
  createTelegramTestStorePath,
  makeModelPickerConfig,
  loadConfig,
  createTelegramBot,
  getTelegramCallbackHandlerForTests,
  getTelegramTestState,
  readOnlySessionEntry,
  firstEditMessageTextArg,
  harness: { telegramBotDepsForTest, replySpy, editMessageTextSpy, answerCallbackQuerySpy },
}: {
  createTelegramTestStorePath: (label: string) => string;
  makeModelPickerConfig: (
    storePath: string,
    overrides: {
      defaultModel?: string;
      models?: Record<string, { agentRuntime?: { id: string } }>;
      omitModels?: boolean;
    },
  ) => OpenClawConfig;
  loadConfig: ReturnType<Harness["getLoadConfigMock"]>;
  createTelegramBot: (options: TelegramBotOptions) => Promise<unknown>;
  getTelegramCallbackHandlerForTests: () => (context: Record<string, unknown>) => Promise<void>;
  getTelegramTestState: () => OpenClawTestState;
  readOnlySessionEntry: (
    storePath: string,
  ) => ReturnType<typeof listSessionEntries>[number]["entry"] | undefined;
  firstEditMessageTextArg: (index: number) => unknown;
  harness: Pick<
    Harness,
    "telegramBotDepsForTest" | "replySpy" | "editMessageTextSpy" | "answerCallbackQuerySpy"
  >;
}) {
  it("renders model callback lists with configured display names", async () => {
    const storePath = createTelegramTestStorePath("model-display-names");
    const buildModelsProviderDataMock = vi.mocked(telegramBotDepsForTest.buildModelsProviderData);
    buildModelsProviderDataMock.mockResolvedValueOnce({
      byProvider: new Map<string, Set<string>>([["openai", new Set(["gpt-5", "gpt-4.1"])]]),
      providers: ["openai"],
      resolvedDefault: { provider: "openai", model: "gpt-5" },
      modelCatalog: [],
      modelNames: new Map<string, string>([
        ["openai/gpt-4.1", "GPT 4.1 Bridge"],
        ["openai/gpt-5", "GPT Five Bridge"],
      ]),
    });

    const config = makeModelPickerConfig(storePath, {
      defaultModel: "openai/gpt-5",
      omitModels: true,
    });

    loadConfig.mockReturnValue(config);
    await createTelegramBot({
      token: "tok",
      config,
    });
    const callbackHandler = getTelegramCallbackHandlerForTests();

    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-model-display-names-1",
        data: "mdl_list_openai_1",
        message: { message_id: 23 },
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    const params = requireRecord(firstEditMessageTextArg(3), "model picker options");
    const inlineKeyboard = requireRecord(
      params.reply_markup,
      "model picker markup",
    ).inline_keyboard;

    expect(inlineKeyboard).toStrictEqual([
      [{ text: "GPT 4.1 Bridge", callback_data: "mdl_sel_openai/gpt-4.1" }],
      [{ text: "GPT Five Bridge ✓", callback_data: "mdl_sel_openai/gpt-5" }],
      [{ text: "<< Back", callback_data: "mdl_back" }],
    ]);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-display-names-1");
  });

  it("persists the native runtime selected through the Telegram picker", async () => {
    const storePath = createTelegramTestStorePath("native-model-only");
    const config = makeModelPickerConfig(storePath, { omitModels: true });
    const nativeEntry = {
      provider: "acp-opencode",
      id: "big-pickle",
      name: "Big Pickle",
      nativeRuntime: "acp-opencode",
    };
    vi.mocked(telegramBotDepsForTest.buildModelsProviderData).mockResolvedValueOnce({
      byProvider: new Map([["acp-opencode", new Set(["big-pickle"])]]),
      providers: ["acp-opencode"],
      resolvedDefault: { provider: "anthropic", model: "claude-opus-4-6" },
      modelNames: new Map(),
      modelCatalog: [nativeEntry],
    });
    const { createEmptyPluginRegistry } = await import("openclaw/plugin-sdk/plugin-test-runtime");
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "acpx",
      source: "test",
      harness: {
        id: "acp-opencode",
        label: "OpenCode",
        authBootstrap: "harness",
        supports: ({ requestedRuntime }) => ({ supported: requestedRuntime === "acp-opencode" }),
        async runAttempt() {
          throw new Error("Model selection must not execute inference");
        },
      },
    });
    await mockPublishedModelRuntimeForTest({
      config,
      isCurrent: () => true,
      facts: {
        pluginRegistry: registry,
        modelCatalog: { entries: [nativeEntry], routeVariants: [nativeEntry] },
      },
      paths: {
        agentDir: getTelegramTestState().agentDir(),
        workspaceDir: getTelegramTestState().workspaceDir,
      },
      authStore: { version: 1, profiles: {} },
    });
    loadConfig.mockReturnValue(config);
    await createTelegramBot({ token: "tok", config });
    await getTelegramCallbackHandlerForTests()(
      createTelegramCallbackContext({
        id: "native-model-only",
        data: "mdl_sel_acp-opencode/big-pickle",
        message: { message_id: 17 },
      }),
    );
    expect(readOnlySessionEntry(storePath)).toMatchObject({
      providerOverride: "acp-opencode",
      modelOverride: "big-pickle",
      agentRuntimeOverride: "acp-opencode",
    });
    expect(requireRecord(firstEditMessageTextArg(3), "edit params").parse_mode).toBe("HTML");
  });
}
