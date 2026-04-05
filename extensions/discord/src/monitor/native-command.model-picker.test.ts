import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord-api-types/v10";
import * as commandRegistryModule from "openclaw/plugin-sdk/command-auth";
import type { ChatCommandDefinition, CommandArgsParsing } from "openclaw/plugin-sdk/command-auth";
import type { ModelsProviderData } from "openclaw/plugin-sdk/command-auth";
import {
  loadSessionStore,
  resolveStorePath,
  saveSessionStore,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/config-runtime";
import * as configRuntimeModule from "openclaw/plugin-sdk/config-runtime";
import * as dispatcherModule from "openclaw/plugin-sdk/reply-dispatch-runtime";
import * as globalsModule from "openclaw/plugin-sdk/runtime-env";
import * as commandTextModule from "openclaw/plugin-sdk/text-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as modelPickerPreferencesModule from "./model-picker-preferences.js";
import * as modelPickerModule from "./model-picker.js";
import { createModelsProviderData as createBaseModelsProviderData } from "./model-picker.test-utils.js";
import { replyWithDiscordModelPickerProviders } from "./native-command-ui.js";
import { handleDiscordModelPickerInteraction } from "./native-command-ui.js";
import {
  __testing as nativeCommandTesting,
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
} from "./native-command.js";
import { createNoopThreadBindingManager, type ThreadBindingManager } from "./thread-bindings.js";

type ModelPickerContext = Parameters<typeof createDiscordModelPickerFallbackButton>[0];
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
  acknowledge: ReturnType<typeof vi.fn>;
  client: object;
};

let tempDir: string;

function createModelsProviderData(entries: Record<string, string[]>): ModelsProviderData {
  return createBaseModelsProviderData(entries, { defaultProviderOrder: "sorted" });
}

async function waitForCondition(
  predicate: () => boolean,
  opts?: { attempts?: number; delayMs?: number },
): Promise<void> {
  const attempts = opts?.attempts ?? 50;
  const delayMs = opts?.delayMs ?? 0;
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("condition not met");
}

function createModelPickerContext(): ModelPickerContext {
  const cfg = {
    session: {
      store: path.join(tempDir, "sessions.json"),
    },
    channels: {
      discord: {
        dm: {
          enabled: true,
          policy: "open",
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
  };
}

function createInteraction(params?: { userId?: string; values?: string[] }): MockInteraction {
  const userId = params?.userId ?? "owner";
  return {
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
    acknowledge: vi.fn().mockResolvedValue({ ok: true }),
    client: {},
  };
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
    mi: "2",
  };
}

async function runSubmitButton(params: {
  context: ModelPickerContext;
  data: PickerButtonData;
  userId?: string;
}) {
  const button = createDiscordModelPickerFallbackButton(params.context);
  const submitInteraction = createInteraction({ userId: params.userId ?? "owner" });
  await button.run(submitInteraction as unknown as PickerButtonInteraction, params.data);
  return submitInteraction;
}

async function runModelSelect(params: {
  context: ModelPickerContext;
  data?: PickerSelectData;
  userId?: string;
  values?: string[];
}) {
  const select = createDiscordModelPickerFallbackSelect(params.context);
  const selectInteraction = createInteraction({
    userId: params.userId ?? "owner",
    values: params.values ?? ["gpt-4o"],
  });
  await select.run(
    selectInteraction as unknown as PickerSelectInteraction,
    params.data ?? createModelsViewSelectData(),
  );
  return selectInteraction;
}

function expectDispatchedModelSelection(params: {
  dispatchSpy: { mock: { calls: Array<[unknown]> } };
  model: string;
  requireTargetSessionKey?: boolean;
}) {
  const dispatchCall = params.dispatchSpy.mock.calls[0]?.[0] as {
    ctx?: {
      CommandBody?: string;
      CommandArgs?: { values?: { model?: string } };
      CommandTargetSessionKey?: string;
    };
  };
  expect(dispatchCall.ctx?.CommandBody).toBe(`/model ${params.model}`);
  expect(dispatchCall.ctx?.CommandArgs?.values?.model).toBe(params.model);
  if (params.requireTargetSessionKey) {
    if (!dispatchCall.ctx?.CommandTargetSessionKey) {
      throw new Error("model selection dispatch did not include a target session key");
    }
  }
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

function createDispatchSpy() {
  const dispatchSpy = vi
    .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
    .mockResolvedValue({} as never);
  nativeCommandTesting.setDispatchReplyWithDispatcher(
    dispatcherModule.dispatchReplyWithDispatcher as typeof import("openclaw/plugin-sdk/reply-runtime").dispatchReplyWithDispatcher,
  );
  return dispatchSpy;
}

describe("Discord model picker interactions", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-discord-model-picker-"));
    vi.useRealTimers();
    vi.restoreAllMocks();
    nativeCommandTesting.setDispatchReplyWithDispatcher(
      dispatcherModule.dispatchReplyWithDispatcher as typeof import("openclaw/plugin-sdk/reply-runtime").dispatchReplyWithDispatcher,
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("registers distinct fallback ids for button and select handlers", () => {
    const context = createModelPickerContext();
    const button = createDiscordModelPickerFallbackButton(context);
    const select = createDiscordModelPickerFallbackSelect(context);

    expect(button.customId).not.toBe(select.customId);
    expect(button.customId.split(":")[0]).toBe(
      modelPickerModule.DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
    );
    expect(select.customId.split(":")[0]).toBe(
      modelPickerModule.DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
    );
  });

  it("ignores interactions from users other than the picker owner", async () => {
    const context = createModelPickerContext();
    const loadSpy = vi.spyOn(modelPickerModule, "loadDiscordModelPickerData");
    const button = createDiscordModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "intruder" });

    const data: PickerButtonData = {
      cmd: "model",
      act: "back",
      view: "providers",
      u: "owner",
      pg: "1",
    };

    await button.run(interaction as unknown as PickerButtonInteraction, data);

    expect(interaction.acknowledge).toHaveBeenCalledTimes(1);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("requires submit click before routing selected model through /model pipeline", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();

    const selectInteraction = await runModelSelect({ context });

    expect(selectInteraction.update).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();

    const submitInteraction = await runSubmitButton({
      context,
      data: createModelsViewSubmitData(),
    });

    expect(submitInteraction.update).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
      requireTargetSessionKey: true,
    });
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

    await runModelSelect({ context });

    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    const submitData = createModelsViewSubmitData();

    await button.run(submitInteraction as unknown as PickerButtonInteraction, submitData);

    expect(withTimeoutSpy).toHaveBeenCalledTimes(1);
    await waitForCondition(() => dispatchSpy.mock.calls.length === 1);
    expect(submitInteraction.followUp).toHaveBeenCalledTimes(1);
    const followUpPayload = submitInteraction.followUp.mock.calls[0]?.[0] as {
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

    const button = createDiscordModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "owner" });

    const data: PickerButtonData = {
      cmd: "model",
      act: "recents",
      view: "recents",
      u: "owner",
      p: "openai",
      pg: "1",
    };

    await button.run(interaction as unknown as PickerButtonInteraction, data);

    expect(interaction.update).toHaveBeenCalledTimes(1);
    const updatePayload = interaction.update.mock.calls[0]?.[0];
    if (!updatePayload) {
      throw new Error("recents button did not emit an update payload");
    }
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

    // rs=2 -> first deduped recent (default is anthropic/claude-sonnet-4-5, so openai/gpt-4o remains)
    const submitInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "recents",
        u: "owner",
        pg: "1",
        rs: "2",
      },
    });

    expect(submitInteraction.update).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({ dispatchSpy, model: "openai/gpt-4o" });
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
    createDispatchSpy();
    const verboseSpy = vi.spyOn(globalsModule, "logVerbose").mockImplementation(() => {});

    const select = createDiscordModelPickerFallbackSelect(context);
    const selectInteraction = createInteraction({
      userId: "owner",
      values: ["gpt-4o"],
    });
    selectInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };
    const selectData = createModelsViewSelectData();
    await select.run(selectInteraction as unknown as PickerSelectInteraction, selectData);

    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };
    const submitData = createModelsViewSubmitData();

    await button.run(submitInteraction as unknown as PickerButtonInteraction, submitData);

    const mismatchLog = verboseSpy.mock.calls.find((call) =>
      String(call[0] ?? "").includes("model picker override mismatch"),
    )?.[0];
    expect(mismatchLog).toContain("session key agent:worker:subagent:bound");
  });

  it("persists the routed session override when dispatch leaves the session store stale", async () => {
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
    await saveSessionStore(storePath, {
      "agent:worker:subagent:bound": {
        updatedAt: Date.now(),
        sessionId: "bound-session",
      },
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);
    createDispatchSpy();

    const select = createDiscordModelPickerFallbackSelect(context);
    const selectInteraction = createInteraction({
      userId: "owner",
      values: ["gpt-4o"],
    });
    selectInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };
    await select.run(
      selectInteraction as unknown as PickerSelectInteraction,
      createModelsViewSelectData(),
    );

    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };

    await button.run(
      submitInteraction as unknown as PickerButtonInteraction,
      createModelsViewSubmitData(),
    );

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:worker:subagent:bound"]?.providerOverride).toBe("openai");
    expect(store["agent:worker:subagent:bound"]?.modelOverride).toBe("gpt-4o");
    expect(submitInteraction.followUp).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(submitInteraction.followUp.mock.calls[0]?.[0])).toContain(
      "✅ Model set to openai/gpt-4o.",
    );
  });

  it("clears routed overrides when reset selects the default model through the fallback path", async () => {
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
    await saveSessionStore(storePath, {
      "agent:worker:subagent:bound": {
        updatedAt: Date.now(),
        sessionId: "bound-session",
        providerOverride: "openai",
        modelOverride: "gpt-4o",
      },
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);
    createDispatchSpy();

    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };

    await button.run(submitInteraction as unknown as PickerButtonInteraction, {
      cmd: "model",
      act: "reset",
      view: "models",
      u: "owner",
      p: "openai",
      pg: "1",
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:worker:subagent:bound"]?.providerOverride).toBeUndefined();
    expect(store["agent:worker:subagent:bound"]?.modelOverride).toBeUndefined();
    expect(JSON.stringify(submitInteraction.followUp.mock.calls[0]?.[0])).toContain(
      "✅ Model set to anthropic/claude-sonnet-4-5.",
    );
  });

  it("clears stale auth profile state when fallback persists a routed model override", async () => {
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
    await saveSessionStore(storePath, {
      "agent:worker:subagent:bound": {
        updatedAt: Date.now(),
        sessionId: "bound-session",
        authProfileOverride: "openai:legacy",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 3,
      },
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);
    createDispatchSpy();

    const select = createDiscordModelPickerFallbackSelect(context);
    const selectInteraction = createInteraction({
      userId: "owner",
      values: ["gpt-4o"],
    });
    selectInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };
    await select.run(
      selectInteraction as unknown as PickerSelectInteraction,
      createModelsViewSelectData(),
    );

    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };

    await button.run(
      submitInteraction as unknown as PickerButtonInteraction,
      createModelsViewSubmitData(),
    );

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:worker:subagent:bound"]?.authProfileOverride).toBeUndefined();
    expect(store["agent:worker:subagent:bound"]?.authProfileOverrideSource).toBeUndefined();
    expect(
      store["agent:worker:subagent:bound"]?.authProfileOverrideCompactionCount,
    ).toBeUndefined();
  });

  it("accepts the selected model when the fallback re-read matches after a no-op persist", async () => {
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
    await saveSessionStore(storePath, {
      "agent:worker:subagent:bound": {
        updatedAt: Date.now(),
        sessionId: "bound-session",
      },
    });

    const realUpdateSessionStore = configRuntimeModule.updateSessionStore;
    let rewroteBeforeFallback = false;
    vi.spyOn(configRuntimeModule, "updateSessionStore").mockImplementation(
      async (targetStorePath, mutator) => {
        if (!rewroteBeforeFallback && targetStorePath === storePath) {
          rewroteBeforeFallback = true;
          await realUpdateSessionStore(storePath, (store) => {
            const entry = store["agent:worker:subagent:bound"];
            if (!entry) {
              return;
            }
            entry.providerOverride = "openai";
            entry.modelOverride = "gpt-4o";
          });
        }
        return await realUpdateSessionStore(targetStorePath, mutator);
      },
    );

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);
    createDispatchSpy();

    const select = createDiscordModelPickerFallbackSelect(context);
    const selectInteraction = createInteraction({
      userId: "owner",
      values: ["gpt-4o"],
    });
    selectInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };
    await select.run(
      selectInteraction as unknown as PickerSelectInteraction,
      createModelsViewSelectData(),
    );

    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };

    await button.run(
      submitInteraction as unknown as PickerButtonInteraction,
      createModelsViewSubmitData(),
    );

    expect(JSON.stringify(submitInteraction.followUp.mock.calls[0]?.[0])).toContain(
      "✅ Model set to openai/gpt-4o.",
    );
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
    const storePath = resolveStorePath(context.cfg.session?.store, { agentId: "worker" });
    await saveSessionStore(storePath, {
      "agent:worker:subagent:bound": {
        updatedAt: Date.now(),
        sessionId: "bound-session",
      },
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);

    const interaction = createInteraction({ userId: "owner" });
    interaction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };

    await handleDiscordModelPickerInteraction({
      interaction: interaction as unknown as PickerButtonInteraction,
      data: createModelsViewSubmitData(),
      ctx: context,
      safeInteractionCall: async (_label, fn) => await fn(),
      dispatchCommandInteraction: async () => false,
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:worker:subagent:bound"]?.providerOverride).toBeUndefined();
    expect(store["agent:worker:subagent:bound"]?.modelOverride).toBeUndefined();
    expect(JSON.stringify(interaction.followUp.mock.calls[0]?.[0])).toContain(
      "❌ Failed to apply openai/gpt-4o.",
    );
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
});
