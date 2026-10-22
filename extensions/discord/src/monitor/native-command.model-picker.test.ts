import path from "node:path";
import { ChannelType } from "discord-api-types/v10";
import * as commandRegistryModule from "openclaw/plugin-sdk/command-auth-native";
import type { ChatCommandDefinition } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelsRuntimeChoice } from "openclaw/plugin-sdk/models-provider-runtime";
import * as runtimeConfigSnapshotModule from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sessionStoreRuntime from "openclaw/plugin-sdk/session-store-runtime";
import type * as SessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import * as commandTextModule from "openclaw/plugin-sdk/text-utility-runtime";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseCustomId } from "../internal/components.base.js";
import { serializePayload, type MessagePayload } from "../internal/discord.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { resolveDiscordChannelContext } from "./agent-components-context.js";
import * as modelPickerPreferencesModule from "./model-picker-preferences.js";
import * as modelPickerModule from "./model-picker.state.js";
import {
  createResolvedAgentRoute,
  createModelsProviderData as createBaseModelsProviderData,
  setFixtureRuntimeChoices,
} from "./model-picker.test-utils.js";
import { renderDiscordModelPickerModelsView } from "./model-picker.view.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import {
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
} from "./native-command-model-picker-interaction.js";
import { replyWithDiscordModelPickerProviders } from "./native-command-model-picker-ui.js";
import { nativeCommandContext } from "./native-command.dispatch.test-support.js";
import { createMockCommandInteraction } from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager, type ThreadBindingManager } from "./thread-bindings.js";

vi.mock("openclaw/plugin-sdk/runtime-env", { spy: true });

const hostSdk = vi.hoisted(() => ({
  recordDeliveredCommandExchange: vi.fn(async () => ({ ok: true })),
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionTranscriptRuntime>()),
  recordDeliveredCommandExchange: hostSdk.recordDeliveredCommandExchange,
}));

type ModelPickerContext = Parameters<typeof createDiscordModelPickerFallbackButton>[0]["ctx"];
type PickerButton = ReturnType<typeof createDiscordModelPickerFallbackButton>;
type PickerButtonInteraction = Parameters<PickerButton["run"]>[0];
type PickerButtonData = Parameters<PickerButton["run"]>[1];

type PickerComponent = {
  label?: string;
  custom_id?: string;
  disabled?: boolean;
  options?: Array<{ label: string; value: string }>;
  components?: PickerComponent[];
};

type MockInteraction = ReturnType<typeof createInteraction>;

const MODEL_CHANGED = "Available models changed. Open /models and choose again.";
let tempDir: string;
let context: ModelPickerContext;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync(sessionRoot);
    cleanup();
  });
});
const sessionRoot = tempDirs.make("openclaw-discord-model-picker-");

function createModelsProviderData(
  entries: Record<string, string[]> = {
    openai: ["gpt-4.1", "gpt-4o"],
    anthropic: ["claude-sonnet-4-5"],
  },
) {
  return createBaseModelsProviderData(entries, { defaultProviderOrder: "sorted" });
}

function createModelPickerContext(): ModelPickerContext {
  const cfg = {
    session: { store: path.join(tempDir, "sessions.json") },
    channels: { discord: { dmPolicy: "open", dm: { enabled: true } } },
  } as unknown as OpenClawConfig;

  return {
    ...nativeCommandContext(cfg),
    postApplySettleMs: 0,
  };
}

function createInteraction(params?: { userId?: string; values?: string[] }) {
  const channel: { type: ChannelType; id: string; name?: string; parentId?: string } = {
    type: ChannelType.DM,
    id: "dm-1",
  };
  const { user, guild, rawData, reply, followUp, client } = createMockCommandInteraction(params);
  const interaction = {
    user,
    guild,
    rawData,
    reply,
    followUp,
    client,
    channel,
    values: params?.values,
    update: vi.fn().mockResolvedValue({ ok: true }),
    editReply: vi
      .fn<(_payload?: MessagePayload) => Promise<{ ok: boolean }>>()
      .mockResolvedValue({ ok: true }),
    acknowledge: vi.fn(),
    acknowledged: false,
  };
  interaction.acknowledge.mockImplementation(async () => {
    interaction.acknowledged = true;
    return { ok: true };
  });
  return interaction;
}

function createModelCommandDefinition(): ChatCommandDefinition {
  return {
    key: "model",
    nativeName: "model",
    description: "Switch model",
    textAliases: ["/model"],
    acceptsArgs: true,
    argsParsing: "none",
    scope: "native",
  };
}

function mockModelCommandPipeline(modelCommand = createModelCommandDefinition()) {
  vi.spyOn(commandRegistryModule, "findCommandByNativeName").mockImplementation((name) =>
    name === "model" ? modelCommand : undefined,
  );
  vi.spyOn(commandRegistryModule, "listChatCommands").mockReturnValue([modelCommand]);
  vi.spyOn(commandRegistryModule, "resolveCommandArgMenuAsync").mockResolvedValue(null);
}

function createModelsViewSelectData(): PickerButtonData {
  return pickerComponentData({ act: "model", view: "models", p: "openai" });
}

function createModelsViewSubmitData(): PickerButtonData {
  return pickerComponentData({ act: "submit", view: "models", p: "openai", mi: "2" });
}

function pickerComponentData(data: PickerButtonData): PickerButtonData {
  return { cmd: "model", u: "owner", pg: "1", ...data };
}

function replyText(
  interaction: MockInteraction,
  method: "reply" | "editReply" | "followUp" = "editReply",
) {
  const payload = interaction[method].mock.calls[0]?.[0];
  return JSON.stringify(payload === undefined ? payload : serializePayload(payload));
}

function recordRecentMock() {
  return vi
    .spyOn(modelPickerPreferencesModule, "recordDiscordModelPickerRecentModel")
    .mockResolvedValue();
}

function mockRecents() {
  return vi
    .spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels")
    .mockResolvedValue(["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);
}

async function openProviders(cfg = context.cfg, interaction = createInteraction()) {
  await replyWithDiscordModelPickerProviders({
    interaction: interaction as never,
    cfg,
    command: "model",
    userId: "owner",
    accountId: context.accountId,
    threadBindings: context.threadBindings,
    safeInteractionCall,
  });
  return interaction;
}

function providerEntries() {
  return Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`provider-${String(i + 1).padStart(2, "0")}`, ["model"]]),
  );
}

function renderedControls(payload: MessagePayload, firstContainerOnly = true) {
  const rendered = serializePayload(payload) as { components?: PickerComponent[] };
  const containers = rendered.components ?? [];
  return (firstContainerOnly ? containers.slice(0, 1) : containers)
    .flatMap((container) => container.components ?? [])
    .flatMap((row) => row.components ?? []);
}

async function safeInteractionCall<T>(_label: string, fn: () => Promise<T>): Promise<T | null> {
  return await fn();
}

function createDispatchSpy() {
  return vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({ accepted: true });
}

function mockPickerData(data = createModelsProviderData()) {
  return vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(data);
}

function mockRuntimeConfig(cfg: OpenClawConfig | null) {
  vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSnapshot").mockReturnValue(cfg);
  vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSourceSnapshot").mockReturnValue(cfg);
}

function createPicker(
  select = false,
  dispatchCommandInteraction: DispatchDiscordCommandInteraction = createDispatchSpy(),
) {
  const create = select
    ? createDiscordModelPickerFallbackSelect
    : createDiscordModelPickerFallbackButton;
  return create({ ctx: context, safeInteractionCall, dispatchCommandInteraction });
}

async function runSubmitButton(
  data: PickerButtonData,
  dispatchCommandInteraction: DispatchDiscordCommandInteraction = createDispatchSpy(),
  interaction = createInteraction(),
) {
  await createPicker(false, dispatchCommandInteraction).run(
    interaction as unknown as PickerButtonInteraction,
    data,
  );
  return interaction;
}

function prepareModelPicker(data = createModelsProviderData()) {
  mockPickerData(data);
  mockModelCommandPipeline();
  const dispatchSpy = createDispatchSpy();
  return {
    dispatchSpy,
    submit: (componentData: PickerButtonData, interaction?: MockInteraction) =>
      runSubmitButton(componentData, dispatchSpy, interaction),
  };
}

async function runModelSelect(params: {
  data?: PickerButtonData;
  dispatchCommandInteraction?: DispatchDiscordCommandInteraction;
  userId?: string;
  values?: string[];
}) {
  const select = createPicker(true, params.dispatchCommandInteraction);
  const selectInteraction = createInteraction({
    userId: params.userId ?? "owner",
    values: params.values ?? ["gpt-4o"],
  });
  await select.run(
    selectInteraction as unknown as PickerButtonInteraction,
    params.data ?? createModelsViewSelectData(),
  );
  return selectInteraction;
}

function expectDispatchedModelSelection({
  dispatchSpy,
  model,
  runtime,
}: {
  dispatchSpy: ReturnType<typeof createDispatchSpy>;
  model: string;
  runtime?: string;
}) {
  const raw = runtime ? `${model} --runtime ${runtime}` : model;
  expect(dispatchSpy.mock.calls[0]?.[0]).toMatchObject({
    prompt: `/model ${raw}`,
    commandArgs: { values: { model }, raw },
  });
}

function createBoundThreadBindingManager(): ThreadBindingManager {
  const baseManager = createNoopThreadBindingManager("default");
  const now = Date.now();
  return {
    ...baseManager,
    getIdleTimeoutMs: () => 24 * 60 * 60 * 1000,
    getMaxAgeMs: () => 0,
    getByThreadId: (threadId: string) =>
      threadId === "thread-bound"
        ? {
            accountId: "default",
            channelId: "parent-1",
            threadId: "thread-bound",
            targetKind: "subagent",
            targetSessionKey: "agent:worker:subagent:bound",
            agentId: "worker",
            boundBy: "system",
            boundAt: now,
            lastActivityAt: now,
            idleTimeoutMs: 24 * 60 * 60 * 1000,
            maxAgeMs: 0,
          }
        : baseManager.getByThreadId(threadId),
  };
}

it("delivers usable model choices and clears a recovered refresh warning", async () => {
  const data = createModelsProviderData({ openai: ["gpt-4.1"] });
  data.refreshWarning = "Some models could not be refreshed.";
  mockPickerData(data);
  const dispatchSpy = createDispatchSpy();
  const componentData = { cmd: "models", act: "nav", view: "models", u: "owner", p: "openai" };
  const render = async () => {
    const interaction = await runSubmitButton(componentData, dispatchSpy);
    expect(interaction.editReply).toHaveBeenCalledOnce();
    return JSON.stringify(serializePayload(interaction.editReply.mock.calls[0]![0]!));
  };
  const failedPayload = await render();
  expect(failedPayload).toContain("Some models could not be refreshed.");
  expect(failedPayload).toContain('"label":"gpt-4.1"');

  delete data.refreshWarning;
  const recoveredPayload = await render();
  expect(recoveredPayload).not.toContain("Some models could not be refreshed.");
  expect(recoveredPayload).toContain('"label":"gpt-4.1"');
  expect(dispatchSpy).not.toHaveBeenCalled();
});

it.each(["provider", "runtime"] as const)(
  "offers the shared recovery when a retained %s dropdown choice disappears",
  async (action) => {
    mockPickerData(createModelsProviderData({ openai: ["gpt-4.1"] }));
    const dispatchSpy = createDispatchSpy();
    const interaction = await runModelSelect({
      data: { cmd: "models", act: action, view: "models", u: "owner", p: "removed" },
      values: ["removed"],
      dispatchCommandInteraction: dispatchSpy,
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(replyText(interaction)).toContain(MODEL_CHANGED);
  },
);

beforeEach(() => {
  hostSdk.recordDeliveredCommandExchange.mockClear();
  tempDir = tempDirs.make("case-", sessionRoot);
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockRuntimeConfig(null);
  context = createModelPickerContext();
});

afterEach(() => vi.useRealTimers());

it("ignores interactions from users other than the picker owner", async () => {
  const loadSpy = vi.spyOn(modelPickerModule, "loadDiscordModelPickerData");
  const button = createPicker();
  const interaction = createInteraction({ userId: "intruder" });

  const data: PickerButtonData = pickerComponentData({ act: "back", view: "providers" });

  await button.run(interaction as unknown as PickerButtonInteraction, data);

  expect(interaction.acknowledge).toHaveBeenCalledTimes(1);
  expect(interaction.update).not.toHaveBeenCalled();
  expect(loadSpy).not.toHaveBeenCalled();
});

it("defers owner picker interactions before loading model data", async () => {
  const pickerData = createModelsProviderData();
  const loadSpy = vi
    .spyOn(modelPickerModule, "loadDiscordModelPickerData")
    .mockImplementation(async () => {
      expect(interaction.acknowledge).toHaveBeenCalledTimes(1);
      return pickerData;
    });
  const select = createPicker(true);
  const interaction = createInteraction({ userId: "owner", values: ["gpt-4o"] });

  await select.run(interaction as unknown as PickerButtonInteraction, createModelsViewSelectData());

  expect(loadSpy).toHaveBeenCalledTimes(1);
  expect(interaction.editReply).toHaveBeenCalledTimes(1);
  expect(interaction.update).not.toHaveBeenCalled();
});

it.each(["back", "bucket"] as const)(
  "preserves the selected provider bucket for %s interactions",
  async (action) => {
    const providers = providerEntries();
    mockPickerData(createModelsProviderData(providers));
    const selectingBucket = action === "bucket";
    const interaction = createInteraction({
      userId: "owner",
      ...(selectingBucket ? { values: ["21-30"] } : {}),
    });
    const data = {
      cmd: "model",
      act: action,
      view: "providers",
      u: "owner",
      pg: "3",
      pb: selectingBucket ? "1-20" : "21-30",
    };

    await createPicker(selectingBucket).run(
      interaction as unknown as PickerButtonInteraction,
      data,
    );

    const rendered = replyText(interaction);
    expect(rendered).toContain('"value":"provider-21"');
    expect(rendered).not.toContain('"value":"provider-01"');
  },
);

it("uses the hot-reloaded runtime config when old components reset to default", async () => {
  (context.cfg as { agents?: OpenClawConfig["agents"] }).agents = {
    defaults: { model: { primary: "openai/gpt-5.5" }, models: { "openai/gpt-5.5": {} } },
  };
  const runtimeCfg = {
    ...context.cfg,
    agents: {
      defaults: {
        model: { primary: "openai/gpt-4.1" },
        models: { "openai/gpt-5.5": {}, "openai/gpt-4.1": {} },
      },
    },
  } as OpenClawConfig;
  mockRuntimeConfig(runtimeCfg);

  const staleData = createModelsProviderData({ openai: ["gpt-5.5"] });
  staleData.resolvedDefault = { provider: "openai", model: "gpt-5.5" };
  const refreshedData = createModelsProviderData({ openai: ["gpt-5.5", "gpt-4.1"] });
  refreshedData.resolvedDefault = { provider: "openai", model: "gpt-4.1" };
  const loadSpy = vi
    .spyOn(modelPickerModule, "loadDiscordModelPickerData")
    .mockImplementation(async (cfg) => (cfg === runtimeCfg ? refreshedData : staleData));
  mockModelCommandPipeline();
  const dispatchSpy = createDispatchSpy();

  const resetInteraction = await runSubmitButton(
    pickerComponentData({ act: "reset", view: "models" }),
    dispatchSpy,
  );

  expect(loadSpy).toHaveBeenCalledWith(runtimeCfg, "main", { sessionEntry: undefined });
  expectDispatchedModelSelection({ dispatchSpy, model: "openai/gpt-4.1" });
  const dispatchCall = dispatchSpy.mock.calls[0]?.[0];
  expect(dispatchCall?.cfg).toBe(runtimeCfg);
  expect(resetInteraction.followUp).toHaveBeenCalledOnce();
});

it("reports a hidden model error with the authoritative current selection", async () => {
  const recordRecentSpy = recordRecentMock();
  const { dispatchSpy, submit } = prepareModelPicker();
  await sessionStoreRuntime.upsertSessionEntry({
    storePath: path.join(tempDir, "sessions.json"),
    sessionKey: createResolvedAgentRoute().sessionKey,
    entry: {
      sessionId: "picker-hidden-error",
      updatedAt: 1,
      modelOverride: "gpt-4.1",
      providerOverride: "openai",
      agentRuntimeOverride: "codex",
    },
  });
  dispatchSpy.mockResolvedValue({
    accepted: true,
    effectiveRoute: createResolvedAgentRoute(),
    hiddenFinalReply: {
      text: "  Model change was not applied because the session changed.  ",
      isError: true,
    },
  });
  const interaction = await submit(createModelsViewSubmitData());

  expect(interaction.followUp).toHaveBeenCalledOnce();
  expect(interaction.followUp.mock.calls[0]?.[0]).toMatchObject({
    components: [
      {
        components: [
          {
            content:
              "Model change was not applied because the session changed.\nCurrent selection: openai/gpt-4.1 with runtime codex.",
          },
        ],
      },
    ],
  });
  expect(recordRecentSpy).not.toHaveBeenCalled();
});

it.each([
  { selectedRuntime: "default", currentRuntime: "auto", expectedStatus: "success" },
  { selectedRuntime: "codex", currentRuntime: "auto", expectedStatus: "mismatch" },
])(
  "verifies authoritative runtime $selectedRuntime against $currentRuntime",
  async ({ selectedRuntime, currentRuntime, expectedStatus }) => {
    const recordRecentSpy = recordRecentMock();
    const pickerData = createModelsProviderData();
    setFixtureRuntimeChoices(pickerData, new Map([["openai", [native, builtin]]]));
    const { dispatchSpy, submit } = prepareModelPicker(pickerData);
    await sessionStoreRuntime.upsertSessionEntry({
      storePath: path.join(tempDir, "sessions.json"),
      sessionKey: createResolvedAgentRoute().sessionKey,
      entry: {
        sessionId: "picker-runtime",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-4o",
      },
    });
    dispatchSpy.mockResolvedValue({
      accepted: true,
      effectiveRoute: createResolvedAgentRoute(),
      hiddenFinalReply: { text: "scope-aware core notice" },
    });
    const interaction = await submit({ ...createModelsViewSubmitData(), r: selectedRuntime });

    expect(interaction.followUp).toHaveBeenCalledOnce();
    const expectedNotice =
      expectedStatus === "success"
        ? "scope-aware core notice"
        : `⚠️ Tried to set openai/gpt-4o with runtime codex, but current selection is openai/gpt-4o with runtime ${currentRuntime}.`;
    expect(interaction.followUp.mock.calls[0]?.[0]).toMatchObject({
      components: [{ components: [{ content: expectedNotice }] }],
    });
    if (expectedStatus === "success") {
      expect(recordRecentSpy).toHaveBeenCalledOnce();
    } else {
      expect(recordRecentSpy).not.toHaveBeenCalled();
    }
  },
);

it.each(["models", "recents"] as const)(
  "keeps %s selection stable when hot reload shifts its slot",
  async (view) => {
    mockRuntimeConfig({ ...context.cfg });
    const recents = view === "recents";
    const { dispatchSpy, submit } = prepareModelPicker(
      createModelsProviderData({
        openai: recents ? ["a", "b"] : ["a", "aa", "b"],
      }),
    );
    if (recents) {
      vi.spyOn(
        modelPickerPreferencesModule,
        "readDiscordModelPickerRecentModels",
      ).mockResolvedValue(["openai/a", "openai/b"]);
    }
    const data = pickerComponentData({ act: "submit", view, ...(!recents ? { p: "openai" } : {}) });
    const applied = await submit({
      ...data,
      m: modelPickerModule.createDiscordModelPickerModelToken("openai", "b"),
    });
    expectDispatchedModelSelection({ dispatchSpy, model: "openai/b" });
    if (!recents) {
      expect(applied.followUp).toHaveBeenCalledOnce();
    }
    dispatchSpy.mockClear();
    const rejected = await submit({ ...data, ...(recents ? { rs: "1" } : { mi: "2" }) });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(replyText(rejected)).toContain(MODEL_CHANGED);
  },
);

it("keeps full long model identity through pick selection and rendered Submit", async () => {
  const model = `${"a".repeat(100)}x`;
  const sibling = `${"a".repeat(100)}y`;
  const pickerData = createModelsProviderData({ ollama: [model, sibling] });
  const { dispatchSpy, submit } = prepareModelPicker(pickerData);
  const rendered = renderedControls(
    renderDiscordModelPickerModelsView({
      command: "model",
      userId: "owner",
      data: pickerData,
      provider: "ollama",
    }),
  );
  const modelSelect = rendered.find((component) =>
    component.options?.some((option) => option.label === "a".repeat(100)),
  );
  expect(modelSelect?.options?.map((option) => option.value)).toEqual([
    modelPickerModule.createDiscordModelPickerModelToken("ollama", model),
    modelPickerModule.createDiscordModelPickerModelToken("ollama", sibling),
  ]);
  const selectData = parseCustomId(modelSelect?.custom_id ?? "").data;
  const selection = await runModelSelect({
    dispatchCommandInteraction: dispatchSpy,
    data: selectData,
    values: [modelPickerModule.createDiscordModelPickerModelToken("ollama", model)],
  });
  expect(dispatchSpy).not.toHaveBeenCalled();
  expect(JSON.stringify(serializePayload(selection.editReply.mock.calls[0]![0]!))).toContain(
    `Selected: ollama/${model}`,
  );
  const submitButton = renderedControls(selection.editReply.mock.calls[0]![0]!).find(
    (component) => component.label === "Submit",
  );
  expect(submitButton?.disabled).not.toBe(true);
  const submitData = parseCustomId(submitButton?.custom_id ?? "").data;
  expect(submitData.m).toBe(modelPickerModule.createDiscordModelPickerModelToken("ollama", model));
  // A positional index would now target a different model.
  mockPickerData(createModelsProviderData({ ollama: ["0-new", sibling, model] }));
  await submit(submitData);
  expectDispatchedModelSelection({ dispatchSpy, model: `ollama/${model}` });
});

it("rejects a token-valued model missing from the current catalog", async () => {
  const model = "a".repeat(101);
  const { dispatchSpy } = prepareModelPicker(createModelsProviderData({ ollama: ["other"] }));
  const selection = await runModelSelect({
    dispatchCommandInteraction: dispatchSpy,
    data: { cmd: "model", act: "pick", view: "models", u: "owner", p: "ollama" },
    values: [modelPickerModule.createDiscordModelPickerModelToken("ollama", model)],
  });
  expect(dispatchSpy).not.toHaveBeenCalled();
  expect(replyText(selection)).toContain(MODEL_CHANGED);
});

it("requires submit and retains Gateway ownership through the /model pipeline", async () => {
  const dispatchReplyFromConfig =
    vi.fn<NonNullable<ModelPickerContext["dispatchReplyFromConfig"]>>();
  context = { ...context, dispatchReplyFromConfig };
  const { dispatchSpy, submit } = prepareModelPicker();

  const selectInteraction = await runModelSelect({ dispatchCommandInteraction: dispatchSpy });

  expect(selectInteraction.editReply).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(serializePayload(selectInteraction.editReply.mock.calls[0]![0]!)),
  ).toContain("Selected: openai/gpt-4o · OpenClaw Default (press Submit)");
  expect(dispatchSpy).not.toHaveBeenCalled();
  expect(hostSdk.recordDeliveredCommandExchange).toHaveBeenCalledWith(
    expect.objectContaining({
      commandText: "/model",
      replyId: "picker-update",
      replyText: expect.stringContaining("Selected: openai/gpt-4o"),
    }),
  );
  hostSdk.recordDeliveredCommandExchange.mockClear();

  const submitInteraction = await submit(createModelsViewSubmitData());

  expect(submitInteraction.editReply).toHaveBeenCalledTimes(1);
  expect(dispatchSpy).toHaveBeenCalledTimes(1);
  expectDispatchedModelSelection({ dispatchSpy, model: "openai/gpt-4o" });
  const dispatchCall = dispatchSpy.mock.calls[0]?.[0];
  expect(dispatchCall?.dispatchReplyFromConfig).toBe(dispatchReplyFromConfig);
  expect(hostSdk.recordDeliveredCommandExchange).toHaveBeenCalledOnce();
  expect(hostSdk.recordDeliveredCommandExchange).toHaveBeenCalledWith(
    expect.objectContaining({
      commandText: "/model openai/gpt-4o",
      replyId: "selection",
      replyText: expect.not.stringContaining("Applying model change"),
    }),
  );
});

it("routes the default runtime through the hidden /model command", async () => {
  const runtime = "default";
  const pickerData = createModelsProviderData();
  setFixtureRuntimeChoices(pickerData, new Map([["openai", [native, builtin]]]));

  const { dispatchSpy, submit } = prepareModelPicker(pickerData);
  const submitInteraction = await submit({ ...createModelsViewSubmitData(), r: runtime });

  expect(submitInteraction.editReply).toHaveBeenCalledTimes(1);
  expect(dispatchSpy).toHaveBeenCalledTimes(1);
  expectDispatchedModelSelection({ dispatchSpy, model: "openai/gpt-4o", runtime });
});

it("ignores category parent metadata for non-thread component channels", () => {
  const interaction = createInteraction({ userId: "owner" });
  interaction.guild = { id: "guild-1" };
  interaction.channel = {
    type: ChannelType.GuildText,
    id: "channel-1",
    name: "general",
    parentId: "category-1",
    parent: { id: "category-1", name: "category-name" },
  } as MockInteraction["channel"] & { parent?: { id?: string; name?: string } };

  const channelCtx = resolveDiscordChannelContext(
    interaction as unknown as Parameters<typeof resolveDiscordChannelContext>[0],
  );

  expect(channelCtx).toMatchObject({
    isThread: false,
    parentId: undefined,
    parentName: undefined,
    parentSlug: "",
  });
});

it("shows timeout status and skips recents write when apply is still processing", async () => {
  const { dispatchSpy, submit } = prepareModelPicker();
  const recordRecentSpy = recordRecentMock();
  const withTimeoutSpy = vi
    .spyOn(commandTextModule, "withTimeout")
    .mockRejectedValue(new Error("timeout"));

  await runModelSelect({ dispatchCommandInteraction: dispatchSpy });

  const submitInteraction = await submit(createModelsViewSubmitData());

  expect(withTimeoutSpy).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(dispatchSpy).toHaveBeenCalledTimes(1));
  expect(submitInteraction.followUp).toHaveBeenCalledTimes(1);
  expect(replyText(submitInteraction, "followUp")).toContain("still processing");
  expect(recordRecentSpy).not.toHaveBeenCalled();
});

it("clicking Recents button renders recents view", async () => {
  mockPickerData();
  mockRecents();
  const interaction = await runSubmitButton(
    pickerComponentData({ act: "recents", view: "recents", p: "openai" }),
  );

  expect(interaction.editReply).toHaveBeenCalledTimes(1);
  const updateText = replyText(interaction);
  expect(updateText).toContain("gpt-4o");
  expect(updateText).toContain("claude-sonnet-4-5");
});

it("clicking recents model button applies model through /model pipeline", async () => {
  const { dispatchSpy, submit } = prepareModelPicker();
  mockRecents();

  // rs=2 -> first deduped recent (default is anthropic/claude-sonnet-4-5, so openai/gpt-4o remains)
  const submitInteraction = await submit(
    pickerComponentData({ act: "submit", view: "recents", rs: "2" }),
  );

  expect(submitInteraction.editReply).toHaveBeenCalledTimes(1);
  expect(dispatchSpy).toHaveBeenCalledTimes(1);
  expectDispatchedModelSelection({ dispatchSpy, model: "openai/gpt-4o" });
});

it("reports a rejected hidden /model dispatch without reading authoritative state", async () => {
  const readSession = vi.spyOn(sessionStoreRuntime, "getSessionEntryAsync");
  const { dispatchSpy, submit } = prepareModelPicker();
  let readsAtDispatch = 0;
  dispatchSpy.mockImplementation(async () => {
    readsAtDispatch = readSession.mock.calls.length;
    return { accepted: false };
  });
  const interaction = await submit(createModelsViewSubmitData());

  expect(interaction.followUp).toHaveBeenCalledOnce();
  expect(interaction.followUp.mock.calls[0]?.[0]).toMatchObject({
    components: [
      {
        components: [
          { content: "❌ Failed to apply openai/gpt-4o. Try /model openai/gpt-4o directly." },
        ],
      },
    ],
  });
  expect(readsAtDispatch).toBeGreaterThan(0);
  expect(readSession).toHaveBeenCalledTimes(readsAtDispatch);
});

it("loads model picker data from the effective bound route", async () => {
  const entry = {
    sessionId: "bound-session",
    updatedAt: 1,
    providerOverride: "openai",
    authProfileOverride: "openai:work",
    authProfileOverrideSource: "user" as const,
    agentRuntimeOverride: "openclaw",
  };
  await sessionStoreRuntime.upsertSessionEntry({
    storePath: path.join(tempDir, "sessions.json"),
    sessionKey: "agent:worker:subagent:bound",
    entry,
  });
  context.threadBindings = createBoundThreadBindingManager();
  const loadSpy = mockPickerData(createModelsProviderData());
  const interaction = createInteraction({ userId: "owner" });
  interaction.guild = { id: "guild-1" };
  interaction.channel = {
    type: ChannelType.PublicThread,
    id: "thread-bound",
    name: "bound-thread",
    parentId: "parent-1",
  };

  await openProviders(context.cfg, interaction);

  expect(loadSpy).toHaveBeenCalledWith(context.cfg, "worker", {
    sessionEntry: expect.objectContaining(entry),
  });
  expect(hostSdk.recordDeliveredCommandExchange).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "worker",
      sessionKey: "agent:worker:subagent:bound",
      expectedSessionId: "bound-session",
      commandText: "/model",
      replyText: expect.stringContaining("Select a model, then press Submit."),
    }),
  );
});

it("opens the first visible provider when the current model provider is filtered out", async () => {
  const pickerData = createModelsProviderData({
    openai: ["gpt-5.5-codex"],
    vllm: ["qwen3-local"],
  });
  pickerData.resolvedDefault = { provider: "anthropic", model: "claude-opus-4-5" };
  const loadSpy = mockPickerData(pickerData);
  const cfg = {
    ...context.cfg,
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-5" },
        models: { "openai/*": {}, "vllm/*": {} },
      },
    },
  } as OpenClawConfig;

  const interaction = await openProviders(cfg);

  expect(loadSpy).toHaveBeenCalledWith(cfg, "main", { sessionEntry: undefined });
  const payload = replyText(interaction, "followUp");
  expect(payload).toContain("openai");
  expect(payload).toContain("gpt-5.5-codex");
  expect(payload).not.toContain("Provider not found");
});

it("opens the current provider bucket on initial large-provider renders", async () => {
  const entries = providerEntries();
  const pickerData = createModelsProviderData(entries);
  pickerData.resolvedDefault = { provider: "provider-30", model: "model" };
  mockPickerData(pickerData);

  const interaction = await openProviders();

  const payload = replyText(interaction, "followUp");
  expect(payload).toContain("provider-30");
  expect(payload).toContain(";a=back;v=providers;");
  expect(payload).toContain(";pb=");
});

const builtin = { id: "openclaw", label: "OpenClaw", description: "Built-in runtime" };
const native = { id: "codex", label: "Codex", description: "Native runtime" };
function runtimeData(choices: ModelsRuntimeChoice[] | undefined, isCurrent = () => true) {
  const byModel = new Map<string, ModelsRuntimeChoice[]>([["openai/gpt-4.1", [native]]]);
  if (choices !== undefined) {
    byModel.set("openai/gpt-4o", choices);
  }
  return {
    ...createModelsProviderData(),
    runtimeChoicesByProvider: new Map([["openai", [native, builtin]]]),
    runtimeChoicesByModel: byModel,
    isCurrent,
  };
}

it.each([
  { label: "another model's runtime", choices: [builtin], runtime: "codex", current: true },
  { label: "unknown choices", choices: undefined, runtime: "openclaw", current: true },
  { label: "retired choices", choices: [builtin], runtime: "openclaw", current: false },
])("refuses $label without dispatch", async ({ choices, runtime, current }) => {
  const { dispatchSpy, submit } = prepareModelPicker(runtimeData(choices, () => current));
  const interaction = await submit({ ...createModelsViewSubmitData(), r: runtime });
  expect(dispatchSpy).not.toHaveBeenCalled();
  expect(replyText(interaction)).toMatch(/runtime|expired/i);
});

it("keeps a selected runtime identity when current choices reorder", async () => {
  const data = runtimeData([native, builtin]);
  const rendered = renderDiscordModelPickerModelsView({
    command: "model",
    userId: "owner",
    data,
    provider: "openai",
    currentModel: "openai/gpt-4o",
    pendingModel: "openai/gpt-4o",
    pendingModelIndex: 2,
    pendingRuntime: "codex",
  });
  const submitButton = renderedControls(rendered, false).find(
    (component) => component.label === "Submit",
  );
  if (!submitButton?.custom_id) {
    throw new Error("Expected a serialized Submit button");
  }
  data.runtimeChoicesByProvider.set("openai", [builtin, native]);
  data.runtimeChoicesByModel.set("openai/gpt-4o", [builtin, native]);
  const { dispatchSpy, submit } = prepareModelPicker(data);
  await submit(parseCustomId(submitButton.custom_id).data);
  expectDispatchedModelSelection({ dispatchSpy, model: "openai/gpt-4o", runtime: "codex" });
});

it("refuses an unconfirmed positional runtime submission", async () => {
  const { dispatchSpy, submit } = prepareModelPicker(runtimeData([native, builtin]));
  await submit({ ...createModelsViewSubmitData(), ri: "1" });
  expect(dispatchSpy).not.toHaveBeenCalled();
});

it("refuses a generation retired while the applying notice is awaited", async () => {
  let current = true;
  mockPickerData(runtimeData([builtin], () => current));
  mockModelCommandPipeline();
  const interaction = createInteraction();
  interaction.editReply.mockImplementation(async () => {
    current = false;
    return { ok: true };
  });
  const dispatchSpy = createDispatchSpy();
  await runSubmitButton(
    { ...createModelsViewSubmitData(), r: "openclaw" },
    dispatchSpy,
    interaction,
  );
  expect(dispatchSpy).not.toHaveBeenCalled();
});

installDiscordIngressTestRuntime();
