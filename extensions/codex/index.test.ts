import fs from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import plugin from "./index.js";
import {
  createCodexUserInputPrompt,
  resetCodexConversationChatControlsForTests,
} from "./src/conversation-chat-controls.js";

const runCodexAppServerAttemptMock = vi.hoisted(() => vi.fn());
const runCodexAppServerSideQuestionMock = vi.hoisted(() => vi.fn());
const handleCodexConversationInboundClaimMock = vi.hoisted(() => vi.fn());
const handleCodexConversationBindingResolvedMock = vi.hoisted(() => vi.fn());
const handleCodexPlanDecisionCallbackMock = vi.hoisted(() => vi.fn());

vi.mock("./src/app-server/run-attempt.js", () => ({
  runCodexAppServerAttempt: runCodexAppServerAttemptMock,
}));
vi.mock("./src/app-server/side-question.js", () => ({
  runCodexAppServerSideQuestion: runCodexAppServerSideQuestionMock,
}));
vi.mock("./src/conversation-binding.js", () => ({
  handleCodexConversationBindingResolved: handleCodexConversationBindingResolvedMock,
  handleCodexConversationInboundClaim: handleCodexConversationInboundClaimMock,
}));
vi.mock("./src/command-handlers.js", () => ({
  handleCodexPlanDecisionCallback: handleCodexPlanDecisionCallbackMock,
}));

function mockCall(mock: { mock: { calls: unknown[][] } }, index = 0) {
  return mock.mock.calls.at(index);
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mockCall(mock, index)?.at(argIndex);
}

describe("codex plugin", () => {
  afterEach(() => {
    resetCodexConversationChatControlsForTests();
    handleCodexConversationInboundClaimMock.mockReset();
    handleCodexConversationBindingResolvedMock.mockReset();
    handleCodexPlanDecisionCallbackMock.mockReset();
  });

  it("is opt-in by default", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: unknown };

    expect(manifest.enabledByDefault).toBeUndefined();
  });

  it("registers the codex provider and agent harness", () => {
    const registerAgentHarness = vi.fn();
    const registerCommand = vi.fn();
    const registerMediaUnderstandingProvider = vi.fn();
    const registerMigrationProvider = vi.fn();
    const registerProvider = vi.fn();
    const registerInteractiveHandler = vi.fn();
    const on = vi.fn();
    const onConversationBindingResolved = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentHarness,
        registerCommand,
        registerMediaUnderstandingProvider,
        registerMigrationProvider,
        registerProvider,
        registerInteractiveHandler,
        on,
        onConversationBindingResolved,
      }),
    );

    const providerRegistration = mockCallArg(registerProvider) as Record<string, unknown>;
    const agentHarnessRegistration = mockCallArg(registerAgentHarness) as Record<string, unknown>;
    const mediaProviderRegistration = mockCallArg(registerMediaUnderstandingProvider) as
      | Record<string, unknown>
      | undefined;
    const inboundClaimRegistration = mockCall(on) as [unknown, unknown] | undefined;
    const bindingResolvedRegistration = mockCall(onConversationBindingResolved) as
      | [unknown]
      | undefined;

    expect(providerRegistration.id).toBe("codex");
    expect(providerRegistration.label).toBe("Codex");
    expect(agentHarnessRegistration.id).toBe("codex");
    expect(agentHarnessRegistration.label).toBe("Codex agent harness");
    expect(agentHarnessRegistration.deliveryDefaults).toEqual({
      sourceVisibleReplies: "message_tool",
    });
    expect(typeof agentHarnessRegistration.dispose).toBe("function");
    expect(mediaProviderRegistration?.id).toBe("codex");
    expect(mediaProviderRegistration?.capabilities).toEqual(["image"]);
    expect(mediaProviderRegistration?.defaultModels).toEqual({ image: "gpt-5.5" });
    expect(typeof mediaProviderRegistration?.describeImage).toBe("function");
    expect(typeof mediaProviderRegistration?.describeImages).toBe("function");
    const commandRegistration = mockCallArg(registerCommand) as Record<string, unknown> | undefined;
    expect(commandRegistration?.name).toBe("codex");
    expect(commandRegistration?.description).toBe(
      "Inspect and control the Codex app-server harness",
    );
    const migrationRegistration = mockCallArg(registerMigrationProvider) as
      | Record<string, unknown>
      | undefined;
    expect(migrationRegistration?.id).toBe("codex");
    expect(migrationRegistration?.label).toBe("Codex");
    expect(registerInteractiveHandler.mock.calls.map((call) => call[0]?.channel)).toEqual([
      "telegram",
      "discord",
      "slack",
    ]);
    expect(registerInteractiveHandler.mock.calls.map((call) => call[0]?.namespace)).toEqual([
      "codex",
      "codex",
      "codex",
    ]);
    expect(inboundClaimRegistration?.[0]).toBe("inbound_claim");
    expect(typeof inboundClaimRegistration?.[1]).toBe("function");
    expect(typeof bindingResolvedRegistration?.[0]).toBe("function");
  });

  it("registers with capture APIs that do not expose conversation binding hooks yet", () => {
    const registerProvider = vi.fn();
    const api = createTestPluginApi({
      id: "codex",
      name: "Codex",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      registerAgentHarness: vi.fn(),
      registerCommand: vi.fn(),
      registerMediaUnderstandingProvider: vi.fn(),
      registerProvider,
      on: vi.fn(),
    });
    delete (api as { onConversationBindingResolved?: unknown }).onConversationBindingResolved;

    plugin.register(api);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect((mockCallArg(registerProvider) as { id?: string } | undefined)?.id).toBe("codex");
  });

  it("registers interactive handlers that resolve Codex user input callbacks", async () => {
    const registerInteractiveHandler = vi.fn();
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerInteractiveHandler,
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on: vi.fn(),
      }),
    );

    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const prompt = createCodexUserInputPrompt({
      scope: {
        sessionFile: "/tmp/session.jsonl",
        threadId: "thread-1",
        channel: "telegram",
        senderId: "user-1",
        accountId: "default",
      },
      resolveText,
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Pick one",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Workspace", description: "" },
            { label: "Runtime", description: "" },
          ],
        },
      ],
    });
    const buttonValue = prompt.presentation?.blocks
      .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
      .at(1)?.value;
    const telegramRegistration = registerInteractiveHandler.mock.calls
      .map((call) => call[0])
      .find((registration) => registration?.channel === "telegram");

    const reply = vi.fn(async () => undefined);
    const clearButtons = vi.fn(async () => undefined);
    await telegramRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      callback: { payload: buttonValue?.slice("codex:".length) },
      respond: { reply, clearButtons },
    });

    expect(clearButtons).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ text: "Sent answer to Codex." });
    await expect(answered).resolves.toBe("2");
  });

  it("clears Discord Codex input controls after a consumed callback", async () => {
    const registerInteractiveHandler = vi.fn();
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerInteractiveHandler,
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on: vi.fn(),
      }),
    );

    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const prompt = createCodexUserInputPrompt({
      scope: {
        sessionFile: "/tmp/session.jsonl",
        threadId: "thread-1",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
      },
      resolveText,
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Pick one",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Workspace", description: "" },
            { label: "Runtime", description: "" },
          ],
        },
      ],
    });
    const buttonValue = prompt.presentation?.blocks
      .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
      .at(0)?.value;
    const discordRegistration = registerInteractiveHandler.mock.calls
      .map((call) => call[0])
      .find((registration) => registration?.channel === "discord");

    const reply = vi.fn(async () => undefined);
    const clearComponents = vi.fn(async () => undefined);
    await discordRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      interaction: { payload: buttonValue?.slice("codex:".length) },
      respond: { reply, clearComponents },
    });

    expect(clearComponents).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ text: "Sent answer to Codex.", ephemeral: true });
    await expect(answered).resolves.toBe("1");
  });

  it("clears Slack Codex input controls after a consumed callback", async () => {
    const registerInteractiveHandler = vi.fn();
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerInteractiveHandler,
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on: vi.fn(),
      }),
    );

    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const prompt = createCodexUserInputPrompt({
      scope: {
        sessionFile: "/tmp/session.jsonl",
        threadId: "thread-1",
        channel: "slack",
        senderId: "user-1",
        accountId: "default",
        messageThreadId: "thread-ts",
      },
      resolveText,
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Pick one",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Workspace", description: "" },
            { label: "Runtime", description: "" },
          ],
        },
      ],
    });
    const buttonValue = prompt.presentation?.blocks
      .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
      .at(1)?.value;
    const slackRegistration = registerInteractiveHandler.mock.calls
      .map((call) => call[0])
      .find((registration) => registration?.channel === "slack");

    const reply = vi.fn(async () => undefined);
    const editMessage = vi.fn(async () => undefined);
    await slackRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      threadId: "thread-ts",
      interaction: { payload: buttonValue?.slice("codex:".length) },
      respond: { reply, editMessage },
    });

    expect(editMessage).toHaveBeenCalledWith({ blocks: [] });
    expect(reply).toHaveBeenCalledWith({ text: "Sent answer to Codex." });
    await expect(answered).resolves.toBe("2");
  });

  it("clears Codex plan controls after a consumed callback", async () => {
    const registerInteractiveHandler = vi.fn();
    handleCodexPlanDecisionCallbackMock.mockResolvedValueOnce({
      handled: true,
      consumed: true,
      reply: { text: "Codex will stay in plan mode." },
    });
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: { config: { current: () => ({}) } } as never,
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerInteractiveHandler,
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on: vi.fn(),
      }),
    );
    const discordRegistration = registerInteractiveHandler.mock.calls
      .map((call) => call[0])
      .find((registration) => registration?.channel === "discord");

    const reply = vi.fn(async () => undefined);
    const clearComponents = vi.fn(async () => undefined);
    await discordRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      auth: { isAuthorizedSender: true },
      interaction: { payload: "plan:token-1:stay" },
      respond: { reply, clearComponents },
      requestConversationBinding: async () => ({ status: "error", message: "unused" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    expect(handleCodexPlanDecisionCallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: "plan:token-1:stay",
        pluginConfig: {},
      }),
    );
    expect(clearComponents).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      text: "Codex will stay in plan mode.",
      ephemeral: true,
    });
  });

  it("renders progress reply presentations before channel payload delivery", async () => {
    const renderPresentation = vi.fn(async ({ payload }) => ({
      ...payload,
      channelData: {
        discord: {
          presentationComponents: { blocks: [{ type: "actions" }] },
        },
      },
    }));
    const sendPayload = vi.fn(async () => ({ messageId: "message-1", channelId: "channel-1" }));
    const loadAdapter = vi.fn(async () => ({
      presentationCapabilities: {
        supported: true,
        buttons: true,
        limits: { actions: { maxActionsPerRow: 5, maxLabelLength: 80, maxValueBytes: 100 } },
      },
      renderPresentation,
      sendPayload,
    }));
    const on = vi.fn();
    handleCodexConversationInboundClaimMock.mockImplementationOnce(async (event, ctx, options) => {
      await options.sendProgressReply({
        event,
        ctx,
        payload: {
          text: "Codex needs input:",
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Plan", value: "codex:input:token:1" }],
              },
            ],
          },
        },
      });
      return { handled: true, reply: { text: "done" } };
    });

    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {
          channel: { outbound: { loadAdapter } },
          config: { current: () => ({}) },
        } as never,
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerInteractiveHandler: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on,
      }),
    );
    const inboundHandler = mockCall(on)?.[1] as (event: unknown, ctx: unknown) => Promise<unknown>;

    await expect(
      inboundHandler(
        {
          channel: "discord",
          conversationId: "channel-1",
          accountId: "default",
          threadId: "thread-1",
        },
        { accountId: "default" },
      ),
    ).resolves.toEqual({ handled: true, reply: { text: "done" } });

    expect(renderPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        presentation: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              buttons: [expect.objectContaining({ label: "Plan" })],
            }),
          ],
        }),
      }),
    );
    expect(sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          channelData: {
            discord: {
              presentationComponents: { blocks: [{ type: "actions" }] },
            },
          },
        }),
      }),
    );
  });

  it("preserves adapted progress reply presentations when the channel has no renderer", async () => {
    const sendPayload = vi.fn(async () => ({ messageId: "message-1", chatId: "chat-1" }));
    const loadAdapter = vi.fn(async () => ({
      presentationCapabilities: {
        supported: true,
        buttons: true,
        limits: { actions: { maxActionsPerRow: 3, maxLabelLength: 64, maxValueBytes: 64 } },
      },
      sendPayload,
    }));
    const on = vi.fn();
    handleCodexConversationInboundClaimMock.mockImplementationOnce(async (event, ctx, options) => {
      await options.sendProgressReply({
        event,
        ctx,
        payload: {
          text: "Codex needs input:",
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Plan", value: "codex:input:token:1" }],
              },
            ],
          },
        },
      });
      return { handled: true, reply: { text: "done" } };
    });

    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {
          channel: { outbound: { loadAdapter } },
          config: { current: () => ({}) },
        } as never,
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerInteractiveHandler: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on,
      }),
    );
    const inboundHandler = mockCall(on)?.[1] as (event: unknown, ctx: unknown) => Promise<unknown>;

    await inboundHandler(
      {
        channel: "telegram",
        conversationId: "chat-1",
        accountId: "default",
        threadId: "thread-1",
      },
      { accountId: "default" },
    );

    expect(sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          presentation: expect.objectContaining({
            blocks: [
              expect.objectContaining({
                buttons: [expect.objectContaining({ label: "Plan" })],
              }),
            ],
          }),
        }),
      }),
    );
  });

  it("claims the Codex routing providers by default", () => {
    const harness = createCodexAppServerAgentHarness();

    expect(harness.deliveryDefaults?.sourceVisibleReplies).toBe("message_tool");
    expect(
      harness.supports({ provider: "codex", modelId: "gpt-5.4", requestedRuntime: "auto" })
        .supported,
    ).toBe(true);
    const openAiCodex = harness.supports({
      provider: "openai",
      modelId: "gpt-5.4",
      requestedRuntime: "auto",
    });
    expect(openAiCodex.supported).toBe(true);
    const unsupported = harness.supports({
      provider: "9router",
      modelId: "gpt-5.4",
      requestedRuntime: "auto",
    });
    expect(unsupported.supported).toBe(false);
  });

  it("enables the native hook relay for public Codex app-server attempts", async () => {
    const harness = createCodexAppServerAgentHarness({ pluginConfig: { appServer: {} } });
    const result = { success: true };
    runCodexAppServerAttemptMock.mockResolvedValueOnce(result);

    await expect(harness.runAttempt({ prompt: "hello" } as never)).resolves.toBe(result);

    expect(runCodexAppServerAttemptMock).toHaveBeenCalledWith(
      { prompt: "hello" },
      {
        pluginConfig: { appServer: {} },
        nativeHookRelay: { enabled: true },
      },
    );
  });

  it("passes live Codex plugin config into public Codex app-server attempts", async () => {
    const registerAgentHarness = vi.fn();
    const liveConfig = {
      plugins: {
        entries: {
          codex: {
            config: {
              codexPlugins: {
                enabled: true,
                plugins: {
                  "google-calendar": {
                    marketplaceName: "openai-curated",
                    pluginName: "google-calendar",
                  },
                },
              },
            },
          },
        },
      },
    };
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { codexPlugins: { enabled: false } },
        runtime: {
          config: {
            current: () => liveConfig,
          },
        } as never,
        registerAgentHarness,
        registerCommand: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on: vi.fn(),
      }),
    );
    const harness = mockCallArg(registerAgentHarness) as ReturnType<
      typeof createCodexAppServerAgentHarness
    >;
    const result = { success: true };
    runCodexAppServerAttemptMock.mockResolvedValueOnce(result);

    await expect(harness.runAttempt({ prompt: "calendar" } as never)).resolves.toBe(result);

    expect(runCodexAppServerAttemptMock).toHaveBeenCalledWith(
      { prompt: "calendar" },
      {
        pluginConfig: liveConfig.plugins.entries.codex.config,
        nativeHookRelay: { enabled: true },
      },
    );
  });

  it("enables the native hook relay for public Codex side questions", async () => {
    const harness = createCodexAppServerAgentHarness({ pluginConfig: { appServer: {} } });
    const runSideQuestion = harness["runSideQuestion"];
    const result = { text: "ok" };
    runCodexAppServerSideQuestionMock.mockResolvedValueOnce(result);

    if (!runSideQuestion) {
      throw new Error("Expected Codex harness to expose side questions");
    }
    await expect(runSideQuestion({ question: "btw" } as never)).resolves.toBe(result);

    expect(runCodexAppServerSideQuestionMock).toHaveBeenCalledWith(
      { question: "btw" },
      {
        pluginConfig: { appServer: {} },
        nativeHookRelay: { enabled: true },
      },
    );
  });
});
