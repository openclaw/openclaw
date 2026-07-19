// Discord tests cover native command.model picker plugin behavior.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord-api-types/v10";
import * as commandRegistryModule from "openclaw/plugin-sdk/command-auth-native";
import type {
  ChatCommandDefinition,
  CommandArgsParsing,
} from "openclaw/plugin-sdk/command-auth-native";
import type { ModelsProviderData } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import * as runtimeConfigSnapshotModule from "openclaw/plugin-sdk/runtime-config-snapshot";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  getSessionEntry,
  listSessionEntries,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import * as commandTextModule from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCustomId, serializePayload } from "../internal/discord.js";
import { defineThrowingDiscordChannelGetter } from "../test-support/partial-channel.js";
import { resolveDiscordChannelContext } from "./agent-components-context.js";
import * as modelPickerPreferencesModule from "./model-picker-preferences.js";
import * as modelPickerModule from "./model-picker.state.js";
import { createModelsProviderData as createBaseModelsProviderData } from "./model-picker.test-utils.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import { applyDiscordModelPickerSelection } from "./native-command-model-picker-apply.js";
import {
  buildDiscordModelPickerNoticePayload,
  resolveDiscordModelPickerRoute,
} from "./native-command-model-picker-ui.js";
import {
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
  replyWithDiscordModelPickerProviders,
} from "./native-command-ui.js";
import { createNoopThreadBindingManager, type ThreadBindingManager } from "./thread-bindings.js";

vi.mock("openclaw/plugin-sdk/runtime-env", { spy: true });

type ModelPickerContext = Parameters<typeof createDiscordModelPickerFallbackButton>[0]["ctx"];
type PickerButton = ReturnType<typeof createDiscordModelPickerFallbackButton>;
type PickerSelect = ReturnType<typeof createDiscordModelPickerFallbackSelect>;
type PickerButtonInteraction = Parameters<PickerButton["run"]>[0];
type PickerButtonData = Parameters<PickerButton["run"]>[1];
type PickerSelectInteraction = Parameters<PickerSelect["run"]>[0];
type PickerSelectData = Parameters<PickerSelect["run"]>[1];

type MockInteraction = {
  user: { id: string; username: string; globalName: string };
  channel: { type: ChannelType; id: string; name?: string; parentId?: string };
  guild: { id: string } | null;
  rawData: { id: string; member: { roles: string[] } };
  values?: string[];
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
  acknowledged: boolean;
  client: object;
};

type SerializedPickerComponent = {
  type?: number;
  content?: string;
  label?: string;
  custom_id?: string;
  placeholder?: string;
  options?: Array<{ label?: string; value: string; default?: boolean }>;
  components?: SerializedPickerComponent[];
};

function flattenSerializedPickerComponents(
  components: SerializedPickerComponent[] | undefined,
): SerializedPickerComponent[] {
  const flattened: SerializedPickerComponent[] = [];
  for (const component of components ?? []) {
    flattened.push(component, ...flattenSerializedPickerComponents(component.components));
  }
  return flattened;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

let tempDir: string;

function createModelsProviderData(entries: Record<string, string[]>): ModelsProviderData {
  return createBaseModelsProviderData(entries, { defaultProviderOrder: "sorted" });
}

function createModelPickerContext(): ModelPickerContext {
  const cfg = {
    commands: { useAccessGroups: false },
    session: {
      store: path.join(tempDir, "sessions.json"),
    },
    channels: {
      discord: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        dm: {
          enabled: true,
        },
      },
    },
  } as unknown as OpenClawConfig;

  return {
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    threadBindings: createNoopThreadBindingManager("default"),
    postApplySettleMs: 0,
  };
}

function createInteraction(params?: { userId?: string; values?: string[] }): MockInteraction {
  const userId = params?.userId ?? "owner";
  const interaction = {
    user: {
      id: userId,
      username: "tester",
      globalName: "Tester",
    },
    channel: {
      type: ChannelType.DM,
      id: "dm-1",
    },
    guild: null,
    rawData: {
      id: "interaction-1",
      member: { roles: [] },
    },
    values: params?.values,
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
    update: vi.fn().mockResolvedValue({ ok: true }),
    editReply: vi.fn().mockResolvedValue({ ok: true }),
    acknowledge: vi.fn(),
    acknowledged: false,
    client: {},
  };
  interaction.acknowledge.mockImplementation(async () => {
    interaction.acknowledged = true;
    return { ok: true };
  });
  return interaction;
}

function createDefaultModelPickerData(): ModelsProviderData {
  return createModelsProviderData({
    openai: ["gpt-4.1", "gpt-4o"],
    anthropic: ["claude-sonnet-4-5"],
  });
}

function createModelCommandDefinition(): ChatCommandDefinition {
  return {
    key: "model",
    nativeName: "model",
    description: "Switch model",
    textAliases: ["/model"],
    acceptsArgs: true,
    argsParsing: "none" as CommandArgsParsing,
    scope: "native",
  };
}

function mockModelCommandPipeline(modelCommand: ChatCommandDefinition) {
  vi.spyOn(commandRegistryModule, "findCommandByNativeName").mockImplementation((name) =>
    name === "model" ? modelCommand : undefined,
  );
  vi.spyOn(commandRegistryModule, "listChatCommands").mockReturnValue([modelCommand]);
  vi.spyOn(commandRegistryModule, "resolveCommandArgMenu").mockReturnValue(null);
}

function createModelsViewSelectData(): PickerSelectData {
  return {
    cmd: "model",
    act: "model",
    view: "models",
    u: "owner",
    p: "openai",
    pg: "1",
  };
}

function createModelsViewSubmitData(): PickerButtonData {
  return {
    cmd: "model",
    act: "submit",
    view: "models",
    u: "owner",
    p: "openai",
    pg: "1",
    m: modelPickerModule.createDiscordModelPickerModelFingerprint("openai", "gpt-4o"),
  };
}

async function safeInteractionCall<T>(_label: string, fn: () => Promise<T>): Promise<T | null> {
  return await fn();
}

function createDispatchSpy() {
  return vi.fn<DispatchDiscordCommandInteraction>().mockImplementation(async (params) => {
    const route = await resolveDiscordModelPickerRoute({
      interaction: params.interaction,
      cfg: params.cfg,
      accountId: params.accountId,
      threadBindings: params.threadBindings,
    });
    return {
      accepted: true,
      effectiveRoute: route,
      coreCommandAuthorization: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        commandName: params.command.key,
        rawArguments: params.commandArgs?.raw,
        values: params.commandAuthorizationValues,
      },
    };
  });
}

async function bindPickerDataToInteraction<T extends PickerButtonData>(params: {
  context: ModelPickerContext;
  interaction: MockInteraction;
  data: T;
  authorityUserId?: string;
}): Promise<T> {
  const authorityUserId = params.authorityUserId ?? params.interaction.user.id;
  const authorityInteraction =
    authorityUserId === params.interaction.user.id
      ? params.interaction
      : {
          ...params.interaction,
          user: { ...params.interaction.user, id: authorityUserId },
        };
  const route = await resolveDiscordModelPickerRoute({
    interaction: authorityInteraction as unknown as PickerButtonInteraction,
    cfg: params.context.cfg,
    accountId: params.context.accountId,
    threadBindings: params.context.threadBindings,
  });
  return {
    ...params.data,
    b: modelPickerModule.createDiscordModelPickerInteractionBinding({
      accountId: params.context.accountId,
      userId: authorityUserId,
      route,
    }),
  };
}

type MockWithCalls = { mock: { calls: unknown[][] } };

function firstMockArg(mock: MockWithCalls, label: string) {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function findSerializedComponentByLabel(
  components: SerializedPickerComponent[] | undefined,
  label: string,
): SerializedPickerComponent | undefined {
  for (const component of components ?? []) {
    if (component.label === label) {
      return component;
    }
    const nested = findSerializedComponentByLabel(component.components, label);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function findSerializedSelectByOptionValue(
  components: SerializedPickerComponent[] | undefined,
  value: string,
): SerializedPickerComponent | undefined {
  for (const component of components ?? []) {
    if (component.options?.some((option) => option.value === value)) {
      return component;
    }
    const nested = findSerializedSelectByOptionValue(component.components, value);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function createModelPickerFallbackButton(
  context: ModelPickerContext,
  dispatchCommandInteraction: DispatchDiscordCommandInteraction = createDispatchSpy(),
) {
  return createDiscordModelPickerFallbackButton({
    ctx: context,
    safeInteractionCall,
    dispatchCommandInteraction,
  });
}

function createModelPickerFallbackSelect(
  context: ModelPickerContext,
  dispatchCommandInteraction: DispatchDiscordCommandInteraction = createDispatchSpy(),
) {
  return createDiscordModelPickerFallbackSelect({
    ctx: context,
    safeInteractionCall,
    dispatchCommandInteraction,
  });
}

async function runSubmitButton(params: {
  context: ModelPickerContext;
  data: PickerButtonData;
  dispatchCommandInteraction?: DispatchDiscordCommandInteraction;
  userId?: string;
}) {
  const button = createModelPickerFallbackButton(params.context, params.dispatchCommandInteraction);
  const submitInteraction = createInteraction({ userId: params.userId ?? "owner" });
  const data = await bindPickerDataToInteraction({
    context: params.context,
    interaction: submitInteraction,
    data: params.data,
  });
  await button.run(submitInteraction as unknown as PickerButtonInteraction, data);
  return submitInteraction;
}

async function runModelSelect(params: {
  context: ModelPickerContext;
  data?: PickerSelectData;
  dispatchCommandInteraction?: DispatchDiscordCommandInteraction;
  userId?: string;
  values?: string[];
}) {
  const select = createModelPickerFallbackSelect(params.context, params.dispatchCommandInteraction);
  const selectInteraction = createInteraction({
    userId: params.userId ?? "owner",
    values: params.values ?? [
      modelPickerModule.createDiscordModelPickerModelFingerprint("openai", "gpt-4o"),
    ],
  });
  const data = await bindPickerDataToInteraction({
    context: params.context,
    interaction: selectInteraction,
    data: params.data ?? createModelsViewSelectData(),
  });
  await select.run(selectInteraction as unknown as PickerSelectInteraction, data);
  return selectInteraction;
}

function expectDispatchedModelSelection(params: {
  dispatchSpy: ReturnType<typeof createDispatchSpy>;
  model: string;
  runtime?: string;
}) {
  const dispatchCall = firstMockArg(params.dispatchSpy, "dispatchCommandInteraction") as
    | Parameters<DispatchDiscordCommandInteraction>[0]
    | undefined;
  expect(dispatchCall?.prompt).toBe(
    params.runtime
      ? `/model ${params.model} --runtime ${params.runtime}`
      : `/model ${params.model}`,
  );
  expect(dispatchCall?.commandArgs?.values?.model).toBe(params.model);
}

function createBoundThreadBindingManager(params: {
  accountId: string;
  threadId: string;
  targetSessionKey: string;
  agentId: string;
}): ThreadBindingManager {
  const baseManager = createNoopThreadBindingManager(params.accountId);
  const now = Date.now();
  return {
    ...baseManager,
    getIdleTimeoutMs: () => 24 * 60 * 60 * 1000,
    getMaxAgeMs: () => 0,
    getByThreadId: (threadId: string) =>
      threadId === params.threadId
        ? {
            accountId: params.accountId,
            channelId: "parent-1",
            threadId: params.threadId,
            targetKind: "subagent",
            targetSessionKey: params.targetSessionKey,
            agentId: params.agentId,
            boundBy: "system",
            boundAt: now,
            lastActivityAt: now,
            idleTimeoutMs: 24 * 60 * 60 * 1000,
            maxAgeMs: 0,
          }
        : baseManager.getByThreadId(threadId),
  };
}

describe("Discord model picker interactions", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-discord-model-picker-"));
    vi.useRealTimers();
    vi.restoreAllMocks();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSnapshot").mockReturnValue(null);
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSourceSnapshot").mockReturnValue(null);
  });

  afterEach(async () => {
    vi.useRealTimers();
    setActivePluginRegistry(createEmptyPluginRegistry());
    await rm(tempDir, { recursive: true, force: true });
  });

  it("registers distinct fallback ids for button and select handlers", () => {
    const context = createModelPickerContext();
    const button = createModelPickerFallbackButton(context);
    const select = createModelPickerFallbackSelect(context);

    expect(button.customId).not.toBe(select.customId);
    expect(button.customId.split(":")[0]).toBe(
      modelPickerModule.DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
    );
    expect(select.customId.split(":")[0]).toBe(
      modelPickerModule.DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
    );
  });

  it("keeps the shared picker unchanged when another user clicks it", async () => {
    const context = createModelPickerContext();
    const loadSpy = vi.spyOn(modelPickerModule, "loadDiscordModelPickerData");
    const button = createModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "intruder" });

    const data: PickerButtonData = {
      cmd: "model",
      act: "back",
      view: "providers",
      u: "owner",
      pg: "1",
    };

    const boundData = await bindPickerDataToInteraction({
      context,
      interaction,
      data,
      authorityUserId: "owner",
    });
    await button.run(interaction as unknown as PickerButtonInteraction, boundData);

    expect(interaction.acknowledge).toHaveBeenCalledTimes(1);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    const notice = firstMockArg(interaction.followUp, "interaction.followUp") as {
      ephemeral?: boolean;
    };
    expect(notice.ephemeral).toBe(true);
    expect(JSON.stringify(notice)).toContain("not authorized for this session");
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("defers owner picker interactions before loading model data", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const loadSpy = vi
      .spyOn(modelPickerModule, "loadDiscordModelPickerData")
      .mockImplementation(async () => {
        expect(interaction.acknowledge).toHaveBeenCalledTimes(1);
        return pickerData;
      });
    const select = createModelPickerFallbackSelect(context);
    const interaction = createInteraction({
      userId: "owner",
      values: [modelPickerModule.createDiscordModelPickerModelFingerprint("openai", "gpt-4o")],
    });

    const data = await bindPickerDataToInteraction({
      context,
      interaction,
      data: createModelsViewSelectData(),
    });
    await select.run(interaction as unknown as PickerSelectInteraction, data);

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("uses the hot-reloaded runtime config when old components reset to default", async () => {
    const context = createModelPickerContext();
    (context.cfg as { agents?: OpenClawConfig["agents"] }).agents = {
      defaults: {
        model: { primary: "openai/gpt-5.5" },
        models: {
          "openai/gpt-5.5": {},
        },
      },
    };
    const runtimeCfg = {
      ...context.cfg,
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-terra" },
          models: {
            "openai/gpt-5.5": {},
            "openai/gpt-5.6-terra": {},
          },
        },
      },
    } as OpenClawConfig;
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSnapshot").mockReturnValue(runtimeCfg);
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSourceSnapshot").mockReturnValue(
      runtimeCfg,
    );

    const staleData = createModelsProviderData({ openai: ["gpt-5.5"] });
    staleData.resolvedDefault = { provider: "openai", model: "gpt-5.5" };
    const runtimeData = createModelsProviderData({
      openai: ["gpt-5.5", "gpt-5.6-terra"],
    });
    runtimeData.resolvedDefault = { provider: "openai", model: "gpt-5.6-terra" };
    const loadSpy = vi
      .spyOn(modelPickerModule, "loadDiscordModelPickerData")
      .mockImplementation(async (cfg) => (cfg === runtimeCfg ? runtimeData : staleData));
    const modelCommand = createModelCommandDefinition();
    mockModelCommandPipeline(modelCommand);
    const dispatchSpy = createDispatchSpy();

    const resetInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "reset",
        view: "models",
        u: "owner",
        pg: "1",
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(loadSpy).toHaveBeenCalledWith(runtimeCfg, "main");
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-5.6-terra",
    });
    const dispatchCall = firstMockArg(dispatchSpy, "dispatchCommandInteraction") as
      | Parameters<DispatchDiscordCommandInteraction>[0]
      | undefined;
    expect(dispatchCall?.cfg).toBe(runtimeCfg);
    expect(
      JSON.stringify(firstMockArg(resetInteraction.followUp, "interaction.followUp")),
    ).toContain("✅ Model set to openai/gpt-5.6-terra.");
  });

  it("keeps a pending model stable when hot reload reorders the catalog", async () => {
    const context = createModelPickerContext();
    const runtimeCfg = { ...context.cfg } as OpenClawConfig;
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSnapshot").mockReturnValue(runtimeCfg);
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSourceSnapshot").mockReturnValue(
      runtimeCfg,
    );

    const runtimeData = createModelsProviderData({ openai: ["a", "aa", "b"] });
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(runtimeData);
    mockModelCommandPipeline(createModelCommandDefinition());
    const dispatchSpy = createDispatchSpy();

    const submitInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "models",
        u: "owner",
        p: "openai",
        pg: "1",
        m: modelPickerModule.createDiscordModelPickerModelFingerprint("openai", "b"),
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expectDispatchedModelSelection({ dispatchSpy, model: "openai/b" });
    expect(
      JSON.stringify(firstMockArg(submitInteraction.followUp, "interaction.followUp")),
    ).toContain("✅ Model set to openai/b.");

    dispatchSpy.mockClear();
    const legacyInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "models",
        u: "owner",
        p: "openai",
        pg: "1",
        mi: "2",
      },
      dispatchCommandInteraction: dispatchSpy,
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(firstMockArg(legacyInteraction.update, "interaction.update"))).toContain(
      "no longer available",
    );
  });

  it("requires submit click before routing selected model through /model pipeline", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();

    const selectInteraction = await runModelSelect({
      context,
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(selectInteraction.editReply).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();

    const submitInteraction = await runSubmitButton({
      context,
      data: createModelsViewSubmitData(),
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(submitInteraction.editReply).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
    });
  });

  it("preserves an exact long model id through opaque select and compact submit state", async () => {
    const context = createModelPickerContext();
    const provider = "azure-openai-responses";
    const model = ` ${"🚀model-segment-".repeat(350)}`;
    const pickerData = createModelsProviderData({ [provider]: [model] });
    pickerData.runtimeChoicesByProvider = new Map([
      [
        provider,
        [
          { id: "codex", label: "Codex" },
          { id: "openclaw", label: "OpenClaw Default" },
        ],
      ],
    ]);
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(createModelCommandDefinition());
    const dispatchSpy = createDispatchSpy();
    const runtimeFingerprint = modelPickerModule.createDiscordModelPickerRuntimeFingerprint(
      provider,
      "codex",
    );
    const modelFingerprint = modelPickerModule.createDiscordModelPickerModelFingerprint(
      provider,
      model,
    );

    const selectInteraction = await runModelSelect({
      context,
      dispatchCommandInteraction: dispatchSpy,
      values: [modelFingerprint],
      data: {
        cmd: "model",
        act: "model",
        view: "models",
        p: provider,
        rt: runtimeFingerprint,
        pg: "1",
      },
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    const rendered = serializePayload(
      firstMockArg(selectInteraction.editReply, "interaction.editReply") as never,
    ) as { components?: SerializedPickerComponent[] };
    const renderedText = flattenSerializedPickerComponents(rendered.components)
      .map((component) => component.content)
      .filter((content): content is string => content !== undefined);
    expect(renderedText.length).toBeGreaterThan(0);
    expect(renderedText.every((content) => content.length <= 4_000)).toBe(true);
    expect(renderedText.every(isWellFormedUtf16)).toBe(true);
    expect(renderedText.some((content) => content.endsWith("…"))).toBe(true);
    const submit = findSerializedComponentByLabel(rendered.components, "Submit");
    const submitCustomId = submit?.custom_id;
    expect(submitCustomId).toBeDefined();
    expect(submitCustomId?.length).toBeLessThanOrEqual(100);
    const parsedSubmit = parseCustomId(submitCustomId ?? "");
    expect(parsedSubmit.key).toBe(modelPickerModule.DISCORD_MODEL_PICKER_CUSTOM_ID_KEY);
    expect(parsedSubmit.data.f).toBe(
      modelPickerModule.createDiscordModelPickerProviderFingerprint(provider),
    );

    await runSubmitButton({
      context,
      data: parsedSubmit.data as PickerButtonData,
      dispatchCommandInteraction: dispatchSpy,
    });

    expectDispatchedModelSelection({
      dispatchSpy,
      model: `${provider}/${model}`,
      runtime: "codex",
    });
    const dispatchCall = firstMockArg(dispatchSpy, "dispatchCommandInteraction") as
      | Parameters<DispatchDiscordCommandInteraction>[0]
      | undefined;
    expect(dispatchCall?.commandArgs?.raw).toBe(`${provider}/${model} --runtime codex`);
  });

  it("caps long picker notices without splitting Unicode", () => {
    const payload = serializePayload(
      buildDiscordModelPickerNoticePayload(`Notice: ${"😀".repeat(2_500)}`),
    ) as { components?: SerializedPickerComponent[] };
    const content = requireValue(
      flattenSerializedPickerComponents(payload.components).find(
        (component) => component.content !== undefined,
      )?.content,
      "picker notice should render text",
    );

    expect(content.length).toBeLessThanOrEqual(4_000);
    expect(content.endsWith("…")).toBe(true);
    expect(isWellFormedUtf16(content)).toBe(true);
  });

  it("navigates paginated runtime choices without selecting a positional runtime", async () => {
    const context = createModelPickerContext();
    const pickerData = createModelsProviderData({ openai: ["gpt-4o"] });
    pickerData.runtimeChoicesByProvider = new Map([
      [
        "openai",
        Array.from({ length: 50 }, (_, index) => ({
          id: `runtime-${String(index + 1).padStart(2, "0")}`,
          label: `Runtime ${index + 1}`,
        })),
      ],
    ]);
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    const dispatchSpy = createDispatchSpy();

    const interaction = await runModelSelect({
      context,
      dispatchCommandInteraction: dispatchSpy,
      values: [modelPickerModule.DISCORD_MODEL_PICKER_RUNTIME_PAGE_NEXT_VALUE],
      data: {
        cmd: "model",
        act: "runtime",
        view: "models",
        p: "openai",
        rp: "1",
        pg: "1",
      },
    });

    expect(dispatchSpy).not.toHaveBeenCalled();
    const rendered = serializePayload(
      firstMockArg(interaction.editReply, "interaction.editReply") as never,
    ) as { components?: SerializedPickerComponent[] };
    const runtimeSelect = requireValue(
      findSerializedSelectByOptionValue(
        rendered.components,
        modelPickerModule.DISCORD_MODEL_PICKER_RUNTIME_PAGE_PREV_VALUE,
      ),
      "second runtime page should contain previous navigation",
    );
    expect(runtimeSelect.options).toHaveLength(25);
    expect(runtimeSelect.placeholder).toBe("Select runtime (page 2/3)");
    const runtimeState = modelPickerModule.parseDiscordModelPickerData(
      parseCustomId(runtimeSelect.custom_id ?? "").data,
    );
    expect(runtimeState).toMatchObject({
      action: "runtime",
      provider: "openai",
      runtimePage: 2,
    });
    expect(runtimeState?.runtimeFingerprint).toBeUndefined();
  });

  it("selects an exact NBSP model bucket without trimming it away", async () => {
    const context = createModelPickerContext();
    const nbsp = "\u00a0";
    const nbspModels = Array.from({ length: 26 }, (_, index) => `${nbsp}model-${index}`);
    const pickerData = createModelsProviderData({
      openai: [...nbspModels, ...Array.from({ length: 20 }, (_, index) => `a-model-${index}`)],
    });
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    const dispatchSpy = createDispatchSpy();

    const interaction = await runModelSelect({
      context,
      dispatchCommandInteraction: dispatchSpy,
      values: [nbsp],
      data: {
        cmd: "model",
        act: "bucket",
        view: "models",
        p: "openai",
        pg: "1",
      },
    });

    expect(dispatchSpy).not.toHaveBeenCalled();
    const rendered = serializePayload(
      firstMockArg(interaction.editReply, "interaction.editReply") as never,
    ) as { components?: SerializedPickerComponent[] };
    const nbspModelSelect = requireValue(
      findSerializedSelectByOptionValue(
        rendered.components,
        modelPickerModule.createDiscordModelPickerModelFingerprint("openai", nbspModels[0] ?? ""),
      ),
      "NBSP bucket model select should render",
    );
    expect(nbspModelSelect.options).toHaveLength(25);
    const nextButton = requireValue(
      findSerializedComponentByLabel(rendered.components, "Next ▶"),
      "NBSP bucket should retain pagination",
    );
    const nextState = modelPickerModule.parseDiscordModelPickerData(
      parseCustomId(nextButton.custom_id ?? "").data,
    );
    expect(nextState?.modelBucket).toBe(nbsp);
  });

  it("applies the selected model even when component channel.name throws on a partial channel", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    const submitInteraction = createInteraction({ userId: "owner" });
    defineThrowingDiscordChannelGetter(submitInteraction.channel, "name");

    const button = createModelPickerFallbackButton(context, dispatchSpy);
    const data = await bindPickerDataToInteraction({
      context,
      interaction: submitInteraction,
      data: createModelsViewSubmitData(),
    });
    await button.run(submitInteraction as unknown as PickerButtonInteraction, data);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
    });
  });

  it("keeps the selected runtime stable when runtime choices reorder before submit", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const renderedRuntimeFingerprint = modelPickerModule.createDiscordModelPickerRuntimeFingerprint(
      "openai",
      "codex",
    );
    pickerData.runtimeChoicesByProvider = new Map([
      [
        "openai",
        [
          { id: "openclaw", label: "OpenClaw Default", description: "Use OpenClaw." },
          { id: "codex", label: "Codex", description: "Use Codex." },
        ],
      ],
    ]);
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    const submitInteraction = await runSubmitButton({
      context,
      data: {
        ...createModelsViewSubmitData(),
        rt: renderedRuntimeFingerprint,
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(submitInteraction.editReply).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
      runtime: "codex",
    });
    const entries = listSessionEntries({
      storePath: resolveStorePath(context.cfg.session?.store, { agentId: "main" }),
    });
    const entry = entries.find(
      (candidate) =>
        candidate.entry.providerOverride === "openai" && candidate.entry.modelOverride === "gpt-4o",
    )?.entry;
    expect(typeof entry?.sessionId).toBe("string");
    expect(entry?.sessionId).not.toBe("");
    expect(entry?.agentRuntimeOverride).toBe("codex");
  });

  it("accepts the synthesized OpenClaw runtime choice when a provider has no runtime catalog", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    pickerData.runtimeChoicesByProvider = new Map();
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(createModelCommandDefinition());
    const dispatchSpy = createDispatchSpy();

    await runSubmitButton({
      context,
      data: {
        ...createModelsViewSubmitData(),
        rt: modelPickerModule.createDiscordModelPickerRuntimeFingerprint("openai", "openclaw"),
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
      runtime: "openclaw",
    });
    const entry = listSessionEntries({
      storePath: resolveStorePath(context.cfg.session?.store, { agentId: "main" }),
    }).find((candidate) => candidate.entry.modelOverride === "gpt-4o")?.entry;
    expect(entry?.agentRuntimeOverride).toBe("openclaw");
  });

  it("does not report success or record a recent until final runtime state matches", async () => {
    const context = createModelPickerContext();
    const interaction = createInteraction({ userId: "owner" });
    const route = await resolveDiscordModelPickerRoute({
      interaction: interaction as unknown as PickerButtonInteraction,
      cfg: context.cfg,
      accountId: context.accountId,
      threadBindings: context.threadBindings,
    });
    const modelCommand = createModelCommandDefinition();
    const rawArguments = "openai/gpt-4o --runtime openclaw";
    const recordRecentSpy = vi
      .spyOn(modelPickerPreferencesModule, "recordDiscordModelPickerRecentModel")
      .mockResolvedValue(undefined);
    const dispatch = vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({
      accepted: true,
      effectiveRoute: route,
      coreCommandAuthorization: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        commandName: "model",
        rawArguments,
        values: { provider: "openai", model: "gpt-4o", runtime: "openclaw" },
      },
    });

    const result = await applyDiscordModelPickerSelection({
      interaction: interaction as unknown as PickerButtonInteraction,
      selectionCommand: {
        command: modelCommand,
        args: { values: { model: "openai/gpt-4o" }, raw: rawArguments },
        prompt: `/model ${rawArguments}`,
        authorizationValues: {
          provider: "openai",
          model: "gpt-4o",
          runtime: "openclaw",
        },
      },
      dispatchCommandInteraction: dispatch,
      cfg: context.cfg,
      discordConfig: context.discordConfig,
      accountId: context.accountId,
      sessionPrefix: context.sessionPrefix,
      threadBindings: context.threadBindings,
      route,
      resolvedModelRef: "openai/gpt-4o",
      selectedProvider: "openai",
      selectedModel: "gpt-4o",
      selectedRuntime: "openclaw",
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      preferenceScope: { accountId: context.accountId, userId: "owner" },
      settleMs: 0,
      resolveCurrentModel: () => "openai/gpt-4o",
      resolveCurrentRuntime: () => "codex",
      authorizeDirectPersist: async () => ({ allowed: true }),
    });

    expect(result.status).toBe("mismatch");
    expect(recordRecentSpy).not.toHaveBeenCalled();
  });

  it("rejects a dispatch proof for a different selection with colliding raw arguments", async () => {
    const context = createModelPickerContext();
    const interaction = createInteraction({ userId: "owner" });
    const route = await resolveDiscordModelPickerRoute({
      interaction: interaction as unknown as PickerButtonInteraction,
      cfg: context.cfg,
      accountId: context.accountId,
      threadBindings: context.threadBindings,
    });
    const modelCommand = createModelCommandDefinition();
    const rawArguments = "openai/gpt-4o --runtime codex";
    const dispatch = vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({
      accepted: true,
      effectiveRoute: route,
      coreCommandAuthorization: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        commandName: "model",
        rawArguments,
        values: { provider: "openai", model: "gpt-4o", runtime: "codex" },
      },
    });
    const authorizeDirectPersist = vi
      .fn<Parameters<typeof applyDiscordModelPickerSelection>[0]["authorizeDirectPersist"]>()
      .mockResolvedValue({ allowed: true });

    const result = await applyDiscordModelPickerSelection({
      interaction: interaction as unknown as PickerButtonInteraction,
      selectionCommand: {
        command: modelCommand,
        args: {
          values: { model: "openai/gpt-4o --runtime codex" },
          raw: rawArguments,
        },
        prompt: `/model ${rawArguments}`,
        authorizationValues: {
          provider: "openai",
          model: "gpt-4o --runtime codex",
        },
      },
      dispatchCommandInteraction: dispatch,
      cfg: context.cfg,
      discordConfig: context.discordConfig,
      accountId: context.accountId,
      sessionPrefix: context.sessionPrefix,
      threadBindings: context.threadBindings,
      route,
      resolvedModelRef: "openai/gpt-4o --runtime codex",
      selectedProvider: "openai",
      selectedModel: "gpt-4o --runtime codex",
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      preferenceScope: { accountId: context.accountId, userId: "owner" },
      settleMs: 0,
      resolveCurrentModel: () => "anthropic/claude-sonnet-4-5",
      resolveCurrentRuntime: () => "auto",
      authorizeDirectPersist,
    });

    expect(result).toEqual({
      status: "rejected",
      noticeMessage: "❌ Model change authorization did not match this session.",
    });
    expect(authorizeDirectPersist).not.toHaveBeenCalled();
    expect(
      listSessionEntries({
        storePath: resolveStorePath(context.cfg.session?.store, { agentId: route.agentId }),
      }),
    ).toEqual([]);
  });

  it("rejects direct persistence when the session version changes during final authorization", async () => {
    const context = createModelPickerContext();
    const interaction = createInteraction({ userId: "owner" });
    const route = await resolveDiscordModelPickerRoute({
      interaction: interaction as unknown as PickerButtonInteraction,
      cfg: context.cfg,
      accountId: context.accountId,
      threadBindings: context.threadBindings,
    });
    const storePath = resolveStorePath(context.cfg.session?.store, { agentId: route.agentId });
    await upsertSessionEntry({
      storePath,
      sessionKey: route.sessionKey,
      entry: {
        sessionId: "picker-race-original",
        updatedAt: Date.now(),
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-5",
      },
    });
    const originalEntry = requireValue(
      getSessionEntry({ storePath, sessionKey: route.sessionKey, readConsistency: "latest" }),
      "expected original picker session",
    );
    const modelCommand = createModelCommandDefinition();
    const rawArguments = "openai/gpt-4o";
    const dispatch = vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({
      accepted: true,
      effectiveRoute: route,
      coreCommandAuthorization: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        commandName: "model",
        rawArguments,
        values: { provider: "openai", model: "gpt-4o" },
      },
    });
    const authorizeDirectPersist = vi.fn<
      Parameters<typeof applyDiscordModelPickerSelection>[0]["authorizeDirectPersist"]
    >(async (_route, sessionBinding) => {
      expect(sessionBinding).toEqual({
        sessionId: originalEntry.sessionId,
        updatedAt: originalEntry.updatedAt,
      });
      await upsertSessionEntry({
        storePath,
        sessionKey: route.sessionKey,
        entry: {
          sessionId: originalEntry.sessionId,
          updatedAt: Math.max(Date.now(), originalEntry.updatedAt + 1),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
        },
      });
      return { allowed: true } as const;
    });
    const resolveCurrentModel = () => {
      const entry = getSessionEntry({
        storePath,
        sessionKey: route.sessionKey,
        readConsistency: "latest",
      });
      return `${entry?.providerOverride ?? "anthropic"}/${entry?.modelOverride ?? "claude-sonnet-4-5"}`;
    };

    const result = await applyDiscordModelPickerSelection({
      interaction: interaction as unknown as PickerButtonInteraction,
      selectionCommand: {
        command: modelCommand,
        args: { values: { model: "openai/gpt-4o" }, raw: rawArguments },
        prompt: `/model ${rawArguments}`,
        authorizationValues: { provider: "openai", model: "gpt-4o" },
      },
      dispatchCommandInteraction: dispatch,
      cfg: context.cfg,
      discordConfig: context.discordConfig,
      accountId: context.accountId,
      sessionPrefix: context.sessionPrefix,
      threadBindings: context.threadBindings,
      route,
      resolvedModelRef: "openai/gpt-4o",
      selectedProvider: "openai",
      selectedModel: "gpt-4o",
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      preferenceScope: { accountId: context.accountId, userId: "owner" },
      settleMs: 0,
      resolveCurrentModel,
      resolveCurrentRuntime: () => "auto",
      authorizeDirectPersist,
    });

    expect(authorizeDirectPersist).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "rejected",
      noticeMessage: "❌ Model change authorization expired because this session changed.",
    });
    expect(
      getSessionEntry({ storePath, sessionKey: route.sessionKey, readConsistency: "latest" }),
    ).toMatchObject({
      sessionId: "picker-race-original",
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
    });
  });

  it("rejects a removed runtime fingerprint before dispatch or mutation", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    pickerData.runtimeChoicesByProvider = new Map([
      ["openai", [{ id: "openclaw", label: "OpenClaw Default", description: "Use OpenClaw." }]],
    ]);
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(createModelCommandDefinition());
    const dispatchSpy = createDispatchSpy();

    const interaction = await runSubmitButton({
      context,
      data: {
        ...createModelsViewSubmitData(),
        rt: modelPickerModule.createDiscordModelPickerRuntimeFingerprint("openai", "codex"),
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(
      listSessionEntries({
        storePath: resolveStorePath(context.cfg.session?.store, { agentId: "main" }),
      }),
    ).toEqual([]);
    expect(JSON.stringify(interaction.editReply.mock.calls)).toContain("runtime selection expired");
  });

  it("explicitly clears a stored runtime that is incompatible with the selected provider", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    pickerData.runtimeChoicesByProvider = new Map([
      [
        "openai",
        [
          { id: "codex", label: "Codex", description: "Use Codex." },
          { id: "openclaw", label: "OpenClaw Default", description: "Use OpenClaw." },
        ],
      ],
    ]);
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const route = await resolveDiscordModelPickerRoute({
      interaction: createInteraction({ userId: "owner" }) as unknown as PickerButtonInteraction,
      cfg: context.cfg,
      accountId: context.accountId,
      threadBindings: context.threadBindings,
    });
    const storePath = resolveStorePath(context.cfg.session?.store, { agentId: route.agentId });
    await upsertSessionEntry({
      storePath,
      sessionKey: route.sessionKey,
      entry: {
        updatedAt: Date.now(),
        sessionId: "runtime-clear-session",
        providerOverride: "openai",
        modelOverride: "gpt-4o",
        agentRuntimeOverride: "codex",
      },
    });

    const dispatchSpy = createDispatchSpy();
    await runSubmitButton({
      context,
      data: {
        ...createModelsViewSubmitData(),
        p: "anthropic",
        m: modelPickerModule.createDiscordModelPickerModelFingerprint(
          "anthropic",
          "claude-sonnet-4-5",
        ),
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "anthropic/claude-sonnet-4-5",
      runtime: "auto",
    });
    const entry = getSessionEntry({ storePath, sessionKey: route.sessionKey });
    expect(entry?.sessionId).toBe("runtime-clear-session");
    expect(entry?.providerOverride).toBeUndefined();
    expect(entry?.modelOverride).toBeUndefined();
    expect(entry?.agentRuntimeOverride).toBeUndefined();
  });

  it("does not treat legacy agentRuntime config as current picker state", async () => {
    const context = createModelPickerContext();
    (context.cfg as { agents?: { defaults?: { agentRuntime?: { id: string } } } }).agents = {
      defaults: { agentRuntime: { id: "claude-cli" } },
    };
    const pickerData = createDefaultModelPickerData();
    pickerData.runtimeChoicesByProvider = new Map([
      [
        "anthropic",
        [
          { id: "openclaw", label: "OpenClaw Default", description: "Use OpenClaw." },
          { id: "claude-cli", label: "Claude CLI", description: "Use Claude CLI." },
        ],
      ],
    ]);
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    await runSubmitButton({
      context,
      data: {
        ...createModelsViewSubmitData(),
        p: "anthropic",
        m: modelPickerModule.createDiscordModelPickerModelFingerprint(
          "anthropic",
          "claude-sonnet-4-5",
        ),
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expectDispatchedModelSelection({
      dispatchSpy,
      model: "anthropic/claude-sonnet-4-5",
    });
    const entries = listSessionEntries({
      storePath: resolveStorePath(context.cfg.session?.store, { agentId: "main" }),
    });
    const entry = entries.find(
      (candidate) =>
        candidate.entry.providerOverride === "anthropic" &&
        candidate.entry.modelOverride === "claude-sonnet-4-5",
    )?.entry;
    expect(entry?.agentRuntimeOverride).toBeUndefined();
  });

  it("applies the selected model even when component thread parent.name throws on a partial channel", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.guild = { id: "guild-1" };
    const threadChannel = {
      type: ChannelType.PublicThread,
      id: "thread-1",
      parentId: "parent-1",
      parent: { id: "parent-1", name: "parent-name" },
    } as {
      type: ChannelType;
      id: string;
      parentId: string;
      parent?: { id?: string; name?: string };
    };
    submitInteraction.channel = threadChannel as MockInteraction["channel"];
    defineThrowingDiscordChannelGetter(
      threadChannel.parent as { id?: string; name?: string },
      "name",
    );

    const button = createModelPickerFallbackButton(context, dispatchSpy);
    const data = await bindPickerDataToInteraction({
      context,
      interaction: submitInteraction,
      data: createModelsViewSubmitData(),
    });
    await button.run(submitInteraction as unknown as PickerButtonInteraction, data);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
    });
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

    expect(channelCtx.isThread).toBe(false);
    expect(channelCtx.parentId).toBeUndefined();
    expect(channelCtx.parentName).toBeUndefined();
    expect(channelCtx.parentSlug).toBe("");
  });

  it("shows timeout status and skips recents write when apply is still processing", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const recordRecentSpy = vi
      .spyOn(modelPickerPreferencesModule, "recordDiscordModelPickerRecentModel")
      .mockResolvedValue();
    const dispatchSpy = createDispatchSpy();
    const withTimeoutSpy = vi
      .spyOn(commandTextModule, "withTimeout")
      .mockRejectedValue(new Error("timeout"));

    await runModelSelect({ context, dispatchCommandInteraction: dispatchSpy });

    const button = createModelPickerFallbackButton(context, dispatchSpy);
    const submitInteraction = createInteraction({ userId: "owner" });
    const submitData = createModelsViewSubmitData();

    const boundData = await bindPickerDataToInteraction({
      context,
      interaction: submitInteraction,
      data: submitData,
    });
    await button.run(submitInteraction as unknown as PickerButtonInteraction, boundData);

    expect(withTimeoutSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(dispatchSpy).toHaveBeenCalledTimes(1));
    expect(submitInteraction.followUp).toHaveBeenCalledTimes(1);
    const followUpPayload = firstMockArg(submitInteraction.followUp, "interaction.followUp") as {
      components?: Array<{ components?: Array<{ content?: string }> }>;
    };
    const followUpText = JSON.stringify(followUpPayload);
    expect(followUpText).toContain("still processing");
    expect(recordRecentSpy).not.toHaveBeenCalled();
  });

  it("clicking Recents button renders recents view", async () => {
    const context = createModelPickerContext();
    const pickerData = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
      anthropic: ["claude-sonnet-4-5"],
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-5",
    ]);

    const button = createModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "owner" });

    const data: PickerButtonData = {
      cmd: "model",
      act: "recents",
      view: "recents",
      u: "owner",
      p: "openai",
      pg: "1",
    };

    const boundData = await bindPickerDataToInteraction({ context, interaction, data });
    await button.run(interaction as unknown as PickerButtonInteraction, boundData);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const updatePayload = firstMockArg(interaction.editReply, "interaction.editReply");
    const updateText = JSON.stringify(updatePayload);
    expect(updateText).toContain("gpt-4o");
    expect(updateText).toContain("claude-sonnet-4-5");
  });

  it("clicking recents model button applies model through /model pipeline", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-5",
    ]);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();

    const submitInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "recents",
        u: "owner",
        pg: "1",
        m: modelPickerModule.createDiscordModelPickerModelFingerprint("openai", "gpt-4o"),
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(submitInteraction.editReply).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({ dispatchSpy, model: "openai/gpt-4o" });
  });

  it("keeps a recent model stable when hot reload shifts its slot", async () => {
    const context = createModelPickerContext();
    const runtimeCfg = { ...context.cfg } as OpenClawConfig;
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSnapshot").mockReturnValue(runtimeCfg);
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSourceSnapshot").mockReturnValue(
      runtimeCfg,
    );
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(
      createModelsProviderData({ openai: ["a", "b"] }),
    );
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/a",
      "openai/b",
    ]);
    mockModelCommandPipeline(createModelCommandDefinition());
    const dispatchSpy = createDispatchSpy();

    await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "recents",
        u: "owner",
        pg: "1",
        m: modelPickerModule.createDiscordModelPickerModelFingerprint("openai", "b"),
      },
      dispatchCommandInteraction: dispatchSpy,
    });
    expectDispatchedModelSelection({ dispatchSpy, model: "openai/b" });

    dispatchSpy.mockClear();
    const legacyInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "recents",
        u: "owner",
        pg: "1",
        rs: "1",
      },
      dispatchCommandInteraction: dispatchSpy,
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(firstMockArg(legacyInteraction.update, "interaction.update"))).toContain(
      "no longer available",
    );
  });

  it("does not decode compact recents runtime against another provider", async () => {
    const context = createModelPickerContext();
    const pickerData = createModelsProviderData({
      openai: ["gpt-4o"],
      anthropic: ["claude-sonnet-4-5"],
    });
    pickerData.runtimeChoicesByProvider = new Map([
      ["openai", [{ id: "codex", label: "Codex", description: "Use Codex." }]],
      [
        "anthropic",
        [
          { id: "codex", label: "Codex", description: "Use Codex." },
          { id: "claude-cli", label: "Claude CLI", description: "Use Claude CLI." },
        ],
      ],
    ]);
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "recents",
        u: "owner",
        p: "openai",
        rt: modelPickerModule.createDiscordModelPickerRuntimeFingerprint("openai", "codex"),
        pg: "1",
        m: modelPickerModule.createDiscordModelPickerModelFingerprint(
          "anthropic",
          "claude-sonnet-4-5",
        ),
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "anthropic/claude-sonnet-4-5",
    });
  });

  it("verifies model state against the bound thread session", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      threadId: "thread-bound",
      targetSessionKey: "agent:worker:subagent:bound",
      agentId: "worker",
    });
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);
    const dispatchSpy = createDispatchSpy();
    const verboseSpy = vi.mocked(logVerbose);
    verboseSpy.mockClear();
    verboseSpy.mockImplementation(() => {});

    const select = createModelPickerFallbackSelect(context, dispatchSpy);
    const selectInteraction = createInteraction({
      userId: "owner",
      values: [modelPickerModule.createDiscordModelPickerModelFingerprint("openai", "gpt-4o")],
    });
    selectInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };
    const selectData = createModelsViewSelectData();
    const boundSelectData = await bindPickerDataToInteraction({
      context,
      interaction: selectInteraction,
      data: selectData,
    });
    await select.run(selectInteraction as unknown as PickerSelectInteraction, boundSelectData);

    const button = createModelPickerFallbackButton(context, dispatchSpy);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };
    const submitData = createModelsViewSubmitData();

    const boundSubmitData = await bindPickerDataToInteraction({
      context,
      interaction: submitInteraction,
      data: submitData,
    });
    await button.run(submitInteraction as unknown as PickerButtonInteraction, boundSubmitData);

    const mismatchLog = verboseSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("model picker override mismatch"),
    )?.[0];
    expect(mismatchLog).toContain("session key agent:worker:subagent:bound");
  });

  it("persists suffixed LM Studio model overrides when dispatch leaves the routed session stale", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      threadId: "thread-bound",
      targetSessionKey: "agent:worker:subagent:bound",
      agentId: "worker",
    });
    const pickerData = createModelsProviderData({
      anthropic: ["claude-sonnet-4-5"],
      lmstudio: ["unsloth/gemma-4-26b-a4b-it@iq4_xs"],
    });
    const modelCommand = createModelCommandDefinition();
    const storePath = resolveStorePath(context.cfg.session?.store, { agentId: "worker" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:worker:subagent:bound",
      entry: {
        updatedAt: Date.now(),
        sessionId: "bound-session",
      },
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    const button = createModelPickerFallbackButton(context, dispatchSpy);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };

    const data = await bindPickerDataToInteraction({
      context,
      interaction: submitInteraction,
      data: {
        ...createModelsViewSubmitData(),
        p: "lmstudio",
        m: modelPickerModule.createDiscordModelPickerModelFingerprint(
          "lmstudio",
          "unsloth/gemma-4-26b-a4b-it@iq4_xs",
        ),
      },
    });
    await button.run(submitInteraction as unknown as PickerButtonInteraction, data);

    const entry = getSessionEntry({ storePath, sessionKey: "agent:worker:subagent:bound" });
    expect(entry?.providerOverride).toBe("lmstudio");
    expect(entry?.modelOverride).toBe("unsloth/gemma-4-26b-a4b-it@iq4_xs");
    expect(entry?.liveModelSwitchPending).toBe(true);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "lmstudio/unsloth/gemma-4-26b-a4b-it@iq4_xs",
    });
    expect(
      JSON.stringify(firstMockArg(submitInteraction.followUp, "interaction.followUp")),
    ).toContain("✅ Model set to lmstudio/unsloth/gemma-4-26b-a4b-it@iq4_xs.");
  });

  it("does not write a fallback override when hidden /model dispatch is rejected", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      threadId: "thread-bound",
      targetSessionKey: "agent:worker:subagent:bound",
      agentId: "worker",
    });
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();
    const storePath = resolveStorePath(context.cfg.session?.store, { agentId: "worker" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:worker:subagent:bound",
      entry: {
        updatedAt: Date.now(),
        sessionId: "bound-session",
      },
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const button = createModelPickerFallbackButton(
      context,
      vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({ accepted: false }),
    );
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };

    const data = await bindPickerDataToInteraction({
      context,
      interaction: submitInteraction,
      data: createModelsViewSubmitData(),
    });
    await button.run(submitInteraction as unknown as PickerButtonInteraction, data);

    const entry = getSessionEntry({ storePath, sessionKey: "agent:worker:subagent:bound" });
    expect(entry?.providerOverride).toBeUndefined();
    expect(entry?.modelOverride).toBeUndefined();
    expect(
      JSON.stringify(firstMockArg(submitInteraction.followUp, "interaction.followUp")),
    ).toContain("❌ Failed to apply openai/gpt-4o.");
  });

  it("does not persist a fallback override when final authorization denies after preauthorization", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    let policyCalls = 0;
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "model-picker-policy",
      source: "test",
      policy: {
        id: "model-picker-policy",
        description: "Deny the direct persistence boundary",
        handlers: {
          "command.invoke": () =>
            ++policyCalls === 3
              ? { effect: "deny", code: "final-state-changed" }
              : { effect: "pass" },
        },
      },
    });
    setActivePluginRegistry(registry);
    const dispatchSpy = createDispatchSpy();

    const interaction = await runSubmitButton({
      context,
      data: createModelsViewSubmitData(),
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(policyCalls).toBe(3);
    expect(
      listSessionEntries({
        storePath: resolveStorePath(context.cfg.session?.store, { agentId: "main" }),
      }),
    ).toEqual([]);
    expect(JSON.stringify(interaction.followUp.mock.calls)).toContain(
      "Command blocked by authorization policy.",
    );
  });

  it("does not mutate when dispatch authorization names another session", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      threadId: "thread-bound",
      targetSessionKey: "agent:worker:subagent:bound",
      agentId: "worker",
    });
    const pickerData = createDefaultModelPickerData();
    const storePath = resolveStorePath(context.cfg.session?.store, { agentId: "worker" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:worker:subagent:bound",
      entry: { updatedAt: Date.now(), sessionId: "bound-session" },
    });
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(createModelCommandDefinition());
    const dispatch = vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({
      accepted: true,
      coreCommandAuthorization: {
        agentId: "worker",
        sessionKey: "agent:worker:subagent:other",
        commandName: "model",
        rawArguments: "openai/gpt-4o",
        values: { provider: "openai", model: "gpt-4o" },
      },
    });
    const button = createModelPickerFallbackButton(context, dispatch);
    const interaction = createInteraction({ userId: "owner" });
    interaction.channel = { type: ChannelType.PublicThread, id: "thread-bound" };
    const data = await bindPickerDataToInteraction({
      context,
      interaction,
      data: createModelsViewSubmitData(),
    });

    await button.run(interaction as unknown as PickerButtonInteraction, data);

    const entry = getSessionEntry({
      storePath,
      sessionKey: "agent:worker:subagent:bound",
    });
    expect(entry?.sessionId).toBe("bound-session");
    expect(entry?.providerOverride).toBeUndefined();
    expect(entry?.modelOverride).toBeUndefined();
    expect(JSON.stringify(interaction.followUp.mock.calls)).toContain(
      "authorization did not match this session",
    );
  });

  it("does not mutate when final dispatch proof omits the selected runtime", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    pickerData.runtimeChoicesByProvider = new Map([
      [
        "openai",
        [
          { id: "openclaw", label: "OpenClaw", description: "Use OpenClaw." },
          { id: "codex", label: "Codex", description: "Use Codex." },
        ],
      ],
    ]);
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(createModelCommandDefinition());
    const dispatch = vi
      .fn<DispatchDiscordCommandInteraction>()
      .mockImplementation(async (params) => {
        const route = await resolveDiscordModelPickerRoute({
          interaction: params.interaction,
          cfg: params.cfg,
          accountId: params.accountId,
          threadBindings: params.threadBindings,
        });
        return {
          accepted: true,
          effectiveRoute: route,
          coreCommandAuthorization: {
            agentId: route.agentId,
            sessionKey: route.sessionKey,
            commandName: "model",
            rawArguments: "openai/gpt-4o",
            values: { provider: "openai", model: "gpt-4o" },
          },
        };
      });

    const interaction = await runSubmitButton({
      context,
      data: {
        ...createModelsViewSubmitData(),
        rt: modelPickerModule.createDiscordModelPickerRuntimeFingerprint("openai", "codex"),
      },
      dispatchCommandInteraction: dispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      listSessionEntries({
        storePath: resolveStorePath(context.cfg.session?.store, { agentId: "main" }),
      }),
    ).toEqual([]);
    expect(JSON.stringify(interaction.followUp.mock.calls)).toContain(
      "authorization did not match this session",
    );
  });

  it("shows a locked-session rejection without writing a fallback override", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      threadId: "thread-bound",
      targetSessionKey: "agent:worker:subagent:bound",
      agentId: "worker",
    });
    const pickerData = createDefaultModelPickerData();
    pickerData.runtimeChoicesByProvider = new Map([
      [
        "openai",
        [
          { id: "codex", label: "Codex", description: "Use Codex." },
          { id: "openclaw", label: "OpenClaw Default", description: "Use OpenClaw." },
        ],
      ],
    ]);
    const modelCommand = createModelCommandDefinition();
    const storePath = resolveStorePath(context.cfg.session?.store, { agentId: "worker" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:worker:subagent:bound",
      entry: {
        updatedAt: Date.now(),
        sessionId: "bound-session",
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        modelSelectionLocked: true,
      },
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const button = createModelPickerFallbackButton(context, createDispatchSpy());
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };

    const data = await bindPickerDataToInteraction({
      context,
      interaction: submitInteraction,
      data: {
        ...createModelsViewSubmitData(),
        rt: modelPickerModule.createDiscordModelPickerRuntimeFingerprint("openai", "openclaw"),
      },
    });
    await button.run(submitInteraction as unknown as PickerButtonInteraction, data);

    expect(getSessionEntry({ storePath, sessionKey: "agent:worker:subagent:bound" })).toMatchObject(
      {
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        modelSelectionLocked: true,
      },
    );
    expect(
      JSON.stringify(firstMockArg(submitInteraction.followUp, "interaction.followUp")),
    ).toContain("❌ Model selection is locked for this session.");
  });

  it("loads model picker data from the effective bound route", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      threadId: "thread-bound",
      targetSessionKey: "agent:worker:subagent:bound",
      agentId: "worker",
    });
    const loadSpy = vi
      .spyOn(modelPickerModule, "loadDiscordModelPickerData")
      .mockResolvedValue(createDefaultModelPickerData());
    const interaction = createInteraction({ userId: "owner" });
    interaction.guild = { id: "guild-1" };
    interaction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
      name: "bound-thread",
      parentId: "parent-1",
    };

    await replyWithDiscordModelPickerProviders({
      interaction: interaction as never,
      cfg: context.cfg,
      command: "model",
      userId: "owner",
      accountId: context.accountId,
      threadBindings: context.threadBindings,
      preferFollowUp: false,
      safeInteractionCall: async (_label, fn) => await fn(),
    });

    expect(loadSpy).toHaveBeenCalledWith(context.cfg, "worker");
  });

  it("opens the first visible provider when the current model provider is filtered out", async () => {
    const context = createModelPickerContext();
    const pickerData = createModelsProviderData({
      openai: ["gpt-5.5-codex"],
      vllm: ["qwen3-local"],
    });
    pickerData.resolvedDefault = {
      provider: "anthropic",
      model: "claude-opus-4-5",
    };
    const loadSpy = vi
      .spyOn(modelPickerModule, "loadDiscordModelPickerData")
      .mockResolvedValue(pickerData);
    const interaction = createInteraction({ userId: "owner" });
    const cfg = {
      ...context.cfg,
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "openai/*": {},
            "vllm/*": {},
          },
        },
      },
    } as OpenClawConfig;

    await replyWithDiscordModelPickerProviders({
      interaction: interaction as never,
      cfg,
      command: "model",
      userId: "owner",
      accountId: context.accountId,
      threadBindings: context.threadBindings,
      preferFollowUp: false,
      safeInteractionCall: async (_label, fn) => await fn(),
    });

    expect(loadSpy).toHaveBeenCalledWith(cfg, "main");
    const payload = JSON.stringify(firstMockArg(interaction.reply, "interaction.reply"));
    expect(payload).toContain("openai");
    expect(payload).toContain("gpt-5.5-codex");
    expect(payload).not.toContain("Provider not found");
  });

  it("opens the current provider bucket on initial large-provider renders", async () => {
    const context = createModelPickerContext();
    const entries = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `provider-${String(i + 1).padStart(2, "0")}`,
        ["model"],
      ]),
    );
    const pickerData = createModelsProviderData(entries);
    pickerData.resolvedDefault = { provider: "provider-30", model: "model" };
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    const interaction = createInteraction({ userId: "owner" });

    await replyWithDiscordModelPickerProviders({
      interaction: interaction as never,
      cfg: context.cfg,
      command: "model",
      userId: "owner",
      accountId: context.accountId,
      threadBindings: context.threadBindings,
      preferFollowUp: false,
      safeInteractionCall: async (_label, fn) => await fn(),
    });

    const payload = JSON.stringify(firstMockArg(interaction.reply, "interaction.reply"));
    expect(payload).toContain("provider-30");
    expect(payload).toContain(";a=back;v=providers;");
    expect(payload).toContain(";pb=");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
