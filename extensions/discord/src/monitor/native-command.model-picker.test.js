import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as commandRegistryModule from "../../../../src/auto-reply/commands-registry.js";
import * as dispatcherModule from "../../../../src/auto-reply/reply/provider-dispatcher.js";
import * as globalsModule from "../../../../src/globals.js";
import * as timeoutModule from "../../../../src/utils/with-timeout.js";
import * as modelPickerPreferencesModule from "./model-picker-preferences.js";
import * as modelPickerModule from "./model-picker.js";
import { createModelsProviderData as createBaseModelsProviderData } from "./model-picker.test-utils.js";
import {
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect
} from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";
function createModelsProviderData(entries) {
  return createBaseModelsProviderData(entries, { defaultProviderOrder: "sorted" });
}
async function waitForCondition(predicate, opts) {
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
function createModelPickerContext() {
  const cfg = {
    channels: {
      discord: {
        dm: {
          enabled: true,
          policy: "open"
        }
      }
    }
  };
  return {
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    threadBindings: createNoopThreadBindingManager("default")
  };
}
function createInteraction(params) {
  const userId = params?.userId ?? "owner";
  return {
    user: {
      id: userId,
      username: "tester",
      globalName: "Tester"
    },
    channel: {
      type: ChannelType.DM,
      id: "dm-1"
    },
    guild: null,
    rawData: {
      id: "interaction-1",
      member: { roles: [] }
    },
    values: params?.values,
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
    update: vi.fn().mockResolvedValue({ ok: true }),
    acknowledge: vi.fn().mockResolvedValue({ ok: true }),
    client: {}
  };
}
function createDefaultModelPickerData() {
  return createModelsProviderData({
    openai: ["gpt-4.1", "gpt-4o"],
    anthropic: ["claude-sonnet-4-5"]
  });
}
function createModelCommandDefinition() {
  return {
    key: "model",
    nativeName: "model",
    description: "Switch model",
    textAliases: ["/model"],
    acceptsArgs: true,
    argsParsing: "none",
    scope: "native"
  };
}
function mockModelCommandPipeline(modelCommand) {
  vi.spyOn(commandRegistryModule, "findCommandByNativeName").mockImplementation(
    (name) => name === "model" ? modelCommand : void 0
  );
  vi.spyOn(commandRegistryModule, "listChatCommands").mockReturnValue([modelCommand]);
  vi.spyOn(commandRegistryModule, "resolveCommandArgMenu").mockReturnValue(null);
}
function createModelsViewSelectData() {
  return {
    cmd: "model",
    act: "model",
    view: "models",
    u: "owner",
    p: "openai",
    pg: "1"
  };
}
function createModelsViewSubmitData() {
  return {
    cmd: "model",
    act: "submit",
    view: "models",
    u: "owner",
    p: "openai",
    pg: "1",
    mi: "2"
  };
}
async function runSubmitButton(params) {
  const button = createDiscordModelPickerFallbackButton(params.context);
  const submitInteraction = createInteraction({ userId: params.userId ?? "owner" });
  await button.run(submitInteraction, params.data);
  return submitInteraction;
}
async function runModelSelect(params) {
  const select = createDiscordModelPickerFallbackSelect(params.context);
  const selectInteraction = createInteraction({
    userId: params.userId ?? "owner",
    values: params.values ?? ["gpt-4o"]
  });
  await select.run(
    selectInteraction,
    params.data ?? createModelsViewSelectData()
  );
  return selectInteraction;
}
function expectDispatchedModelSelection(params) {
  const dispatchCall = params.dispatchSpy.mock.calls[0]?.[0];
  expect(dispatchCall.ctx?.CommandBody).toBe(`/model ${params.model}`);
  expect(dispatchCall.ctx?.CommandArgs?.values?.model).toBe(params.model);
  if (params.requireTargetSessionKey) {
    expect(dispatchCall.ctx?.CommandTargetSessionKey).toBeDefined();
  }
}
function createBoundThreadBindingManager(params) {
  const baseManager = createNoopThreadBindingManager(params.accountId);
  const now = Date.now();
  return {
    ...baseManager,
    getIdleTimeoutMs: () => 24 * 60 * 60 * 1e3,
    getMaxAgeMs: () => 0,
    getByThreadId: (threadId) => threadId === params.threadId ? {
      accountId: params.accountId,
      channelId: "parent-1",
      threadId: params.threadId,
      targetKind: "subagent",
      targetSessionKey: params.targetSessionKey,
      agentId: params.agentId,
      boundBy: "system",
      boundAt: now,
      lastActivityAt: now,
      idleTimeoutMs: 24 * 60 * 60 * 1e3,
      maxAgeMs: 0
    } : baseManager.getByThreadId(threadId)
  };
}
describe("Discord model picker interactions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  it("registers distinct fallback ids for button and select handlers", () => {
    const context = createModelPickerContext();
    const button = createDiscordModelPickerFallbackButton(context);
    const select = createDiscordModelPickerFallbackSelect(context);
    expect(button.customId).not.toBe(select.customId);
    expect(button.customId.split(":")[0]).toBe(select.customId.split(":")[0]);
  });
  it("ignores interactions from users other than the picker owner", async () => {
    const context = createModelPickerContext();
    const loadSpy = vi.spyOn(modelPickerModule, "loadDiscordModelPickerData");
    const button = createDiscordModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "intruder" });
    const data = {
      cmd: "model",
      act: "back",
      view: "providers",
      u: "owner",
      pg: "1"
    };
    await button.run(interaction, data);
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
    const dispatchSpy = vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({});
    const selectInteraction = await runModelSelect({ context });
    expect(selectInteraction.update).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
    const submitInteraction = await runSubmitButton({
      context,
      data: createModelsViewSubmitData()
    });
    expect(submitInteraction.update).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
      requireTargetSessionKey: true
    });
  });
  it("shows timeout status and skips recents write when apply is still processing", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);
    const recordRecentSpy = vi.spyOn(modelPickerPreferencesModule, "recordDiscordModelPickerRecentModel").mockResolvedValue();
    const dispatchSpy = vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({});
    const withTimeoutSpy = vi.spyOn(timeoutModule, "withTimeout").mockRejectedValue(new Error("timeout"));
    await runModelSelect({ context });
    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    const submitData = createModelsViewSubmitData();
    await button.run(submitInteraction, submitData);
    expect(withTimeoutSpy).toHaveBeenCalledTimes(1);
    await waitForCondition(() => dispatchSpy.mock.calls.length === 1);
    expect(submitInteraction.followUp).toHaveBeenCalledTimes(1);
    const followUpPayload = submitInteraction.followUp.mock.calls[0]?.[0];
    const followUpText = JSON.stringify(followUpPayload);
    expect(followUpText).toContain("still processing");
    expect(recordRecentSpy).not.toHaveBeenCalled();
  });
  it("clicking Recents button renders recents view", async () => {
    const context = createModelPickerContext();
    const pickerData = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
      anthropic: ["claude-sonnet-4-5"]
    });
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-5"
    ]);
    const button = createDiscordModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "owner" });
    const data = {
      cmd: "model",
      act: "recents",
      view: "recents",
      u: "owner",
      p: "openai",
      pg: "1"
    };
    await button.run(interaction, data);
    expect(interaction.update).toHaveBeenCalledTimes(1);
    const updatePayload = interaction.update.mock.calls[0]?.[0];
    expect(updatePayload).toBeDefined();
    expect(updatePayload.components).toBeDefined();
  });
  it("clicking recents model button applies model through /model pipeline", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-5"
    ]);
    mockModelCommandPipeline(modelCommand);
    const dispatchSpy = vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({});
    const submitInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "recents",
        u: "owner",
        pg: "1",
        rs: "2"
      }
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
      agentId: "worker"
    });
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);
    vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({});
    const verboseSpy = vi.spyOn(globalsModule, "logVerbose").mockImplementation(() => {
    });
    const select = createDiscordModelPickerFallbackSelect(context);
    const selectInteraction = createInteraction({
      userId: "owner",
      values: ["gpt-4o"]
    });
    selectInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound"
    };
    const selectData = createModelsViewSelectData();
    await select.run(selectInteraction, selectData);
    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound"
    };
    const submitData = createModelsViewSubmitData();
    await button.run(submitInteraction, submitData);
    const mismatchLog = verboseSpy.mock.calls.find(
      (call) => String(call[0] ?? "").includes("model picker override mismatch")
    )?.[0];
    expect(mismatchLog).toContain("session key agent:worker:subagent:bound");
  });
});
