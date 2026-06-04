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

  it.each(["discord", "telegram"])(
    "resolves typed Codex input answers before %s dispatch",
    async (channel) => {
      const on = vi.fn();
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
          registerInteractiveHandler: vi.fn(),
          registerMediaUnderstandingProvider: vi.fn(),
          registerMigrationProvider: vi.fn(),
          registerProvider: vi.fn(),
          on,
        }),
      );

      let resolveText: (text: string) => void = () => undefined;
      const answered = new Promise<string>((resolve) => {
        resolveText = resolve;
      });
      createCodexUserInputPrompt({
        scope: {
          sessionFile: "/tmp/session.jsonl",
          threadId: "thread-1",
          channel,
          senderId: "user-1",
          accountId: "default",
          sessionKey: "session-key",
          messageThreadId: "chat-1",
        },
        resolveText,
        questions: [
          {
            id: "approval",
            header: "Approval",
            question: "Approve?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Approve", description: "Continue" },
              { label: "Reject", description: "Stop" },
            ],
          },
        ],
      });
      const beforeDispatchRegistration = on.mock.calls.find(
        (call) => call[0] === "before_dispatch",
      );

      const result = await beforeDispatchRegistration?.[1]?.(
        {
          content: "Approve",
          body: "Approve",
          channel,
          accountId: "default",
          sessionKey: "session-key",
          senderId: "user-1",
          threadId: "chat-1",
          isGroup: channel === "discord",
        },
        {
          channelId: channel,
          accountId: "default",
          sessionKey: "session-key",
          senderId: "user-1",
          threadId: "chat-1",
        },
      );

      expect(result).toEqual({ handled: true, text: "Sent answer to Codex." });
      await expect(answered).resolves.toBe("Approve");
    },
  );

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

  it("clears stale Telegram Codex input controls after an expired callback", async () => {
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
    const telegramRegistration = registerInteractiveHandler.mock.calls
      .map((call) => call[0])
      .find((registration) => registration?.channel === "telegram");

    const reply = vi.fn(async () => undefined);
    const clearButtons = vi.fn(async () => undefined);
    await telegramRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      callback: { payload: "input:missing-token:1" },
      respond: { reply, clearButtons },
    });

    expect(clearButtons).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      text: "No pending Codex input request was found. The request may have expired.",
    });
  });

  it("disables Discord Codex input controls after a consumed callback", async () => {
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
    const disableComponents = vi.fn(async () => undefined);
    await discordRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      interaction: { payload: buttonValue?.slice("codex:".length) },
      respond: { reply, clearComponents, disableComponents },
    });

    expect(disableComponents).toHaveBeenCalledTimes(1);
    expect(clearComponents).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ text: "Sent answer to Codex.", ephemeral: true });
    await expect(answered).resolves.toBe("1");
  });

  it("sends partial Discord Codex input callbacks as follow-up replies", async () => {
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

    let resolved = false;
    const prompt = createCodexUserInputPrompt({
      scope: {
        sessionFile: "/tmp/session.jsonl",
        threadId: "thread-1",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
      },
      resolveText: () => {
        resolved = true;
      },
      questions: [
        {
          id: "shape",
          header: "Plan",
          question: "Which plan shape?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Small Patch", description: "" },
            { label: "Feature Slice", description: "" },
          ],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Approve", description: "" },
            { label: "Hold", description: "" },
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
    const followUp = vi.fn(async () => undefined);
    const clearComponents = vi.fn(async () => undefined);
    const disableComponents = vi.fn(async () => undefined);
    await discordRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      interaction: { payload: buttonValue?.slice("codex:".length) },
      respond: { reply, followUp, clearComponents, disableComponents },
    });

    // Partial click on a legacy combined card: the click was accepted
    // and recorded, but the request is not yet resolved because the
    // second question is still unanswered. The button row stays live
    // so the user can click a button for the remaining question.
    expect(disableComponents).not.toHaveBeenCalled();
    expect(clearComponents).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith({
      text: "Recorded answer for Plan.",
      ephemeral: true,
    });
    expect(resolved).toBe(false);
  });

  it("rejects Discord Codex input callbacks from a different thread", async () => {
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

    let resolved = false;
    const prompt = createCodexUserInputPrompt({
      scope: {
        sessionFile: "/tmp/session.jsonl",
        threadId: "thread-1",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
        messageThreadId: "thread-1",
      },
      resolveText: () => {
        resolved = true;
      },
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Pick one",
          isOther: false,
          isSecret: false,
          options: [{ label: "Workspace", description: "" }],
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
    const disableComponents = vi.fn(async () => undefined);
    await discordRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      threadId: "thread-2",
      interaction: { payload: buttonValue?.slice("codex:".length) },
      respond: { reply, disableComponents },
    });

    expect(disableComponents).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      text: "This Codex control belongs to a different thread.",
      ephemeral: true,
    });
    expect(resolved).toBe(false);
  });

  it("keeps Discord Codex input callbacks handled when disabling controls fails", async () => {
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
    const disableComponents = vi.fn(async () => {
      throw new Error("edit failed");
    });
    await expect(
      discordRegistration.handler({
        accountId: "default",
        senderId: "user-1",
        interaction: { payload: buttonValue?.slice("codex:".length) },
        respond: { reply, clearComponents, disableComponents },
      }),
    ).resolves.toEqual({ handled: true });

    expect(disableComponents).toHaveBeenCalledTimes(1);
    expect(clearComponents).not.toHaveBeenCalled();
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

  it("disables Discord Codex plan controls after a consumed callback", async () => {
    const registerInteractiveHandler = vi.fn();
    handleCodexPlanDecisionCallbackMock.mockImplementationOnce(async (params) => {
      await params.onConsumed?.();
      return {
        handled: true,
        consumed: true,
        reply: { text: "Codex will stay in plan mode." },
      };
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
    const disableComponents = vi.fn(async () => undefined);
    await discordRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      auth: { isAuthorizedSender: true },
      interaction: { payload: "plan:token-1:stay" },
      respond: { reply, clearComponents, disableComponents },
      requestConversationBinding: async () => ({ status: "error", message: "unused" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    expect(handleCodexPlanDecisionCallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: "plan:token-1:stay",
        pluginConfig: {},
        onConsumed: expect.any(Function),
      }),
    );
    expect(disableComponents).toHaveBeenCalledTimes(1);
    expect(clearComponents).not.toHaveBeenCalled();
    expect(reply).toHaveBeenNthCalledWith(1, {
      text: "Sent answer to Codex.",
      ephemeral: true,
    });
    expect(reply).toHaveBeenNthCalledWith(2, {
      text: "Codex will stay in plan mode.",
      ephemeral: true,
    });
  });

  it("acknowledges Discord Codex plan controls before slow approval finishes", async () => {
    const registerInteractiveHandler = vi.fn();
    let releaseApproval: () => void = () => undefined;
    const approvalReleased = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const consumed = new Promise<void>((resolve) => {
      handleCodexPlanDecisionCallbackMock.mockImplementationOnce(async (params) => {
        await params.onConsumed?.();
        resolve();
        await approvalReleased;
        return {
          handled: true,
          consumed: true,
          reply: { text: "implemented" },
        };
      });
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
    const disableComponents = vi.fn(async () => undefined);
    const handler = discordRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      auth: { isAuthorizedSender: true },
      interaction: { payload: "plan:token-1:approve-clean" },
      respond: { reply, clearComponents, disableComponents },
      requestConversationBinding: async () => ({ status: "error", message: "unused" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    await consumed;

    expect(disableComponents).toHaveBeenCalledTimes(1);
    expect(clearComponents).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      text: "Sent answer to Codex.",
      ephemeral: true,
    });
    expect(reply).not.toHaveBeenCalledWith({ text: "implemented", ephemeral: true });

    releaseApproval();
    await expect(handler).resolves.toEqual({ handled: true });
    expect(reply).toHaveBeenLastCalledWith({ text: "implemented", ephemeral: true });
  });

  it("acknowledges Telegram Codex plan controls before slow approval finishes", async () => {
    const registerInteractiveHandler = vi.fn();
    let releaseApproval: () => void = () => undefined;
    const approvalReleased = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const consumed = new Promise<void>((resolve) => {
      handleCodexPlanDecisionCallbackMock.mockImplementationOnce(async (params) => {
        await params.onConsumed?.();
        resolve();
        await approvalReleased;
        return {
          handled: true,
          consumed: true,
          reply: { text: "implemented" },
        };
      });
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
    const telegramRegistration = registerInteractiveHandler.mock.calls
      .map((call) => call[0])
      .find((registration) => registration?.channel === "telegram");

    const reply = vi.fn(async () => undefined);
    const clearButtons = vi.fn(async () => undefined);
    const handler = telegramRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      sessionKey: "agent:main:telegram:direct:user-1",
      auth: { isAuthorizedSender: true },
      callback: { payload: "plan:token-1:approve" },
      respond: { reply, clearButtons },
      requestConversationBinding: async () => ({ status: "error", message: "unused" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    await consumed;

    expect(handleCodexPlanDecisionCallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:user-1",
        }),
        payload: "plan:token-1:approve",
        pluginConfig: {},
        onConsumed: expect.any(Function),
      }),
    );
    expect(clearButtons).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ text: "Sent answer to Codex." });
    expect(reply).not.toHaveBeenCalledWith({ text: "implemented" });

    releaseApproval();
    await expect(handler).resolves.toEqual({ handled: true });
    expect(clearButtons).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenLastCalledWith({ text: "implemented" });
  });

  it("acknowledges Slack Codex plan controls before slow approval finishes", async () => {
    const registerInteractiveHandler = vi.fn();
    let releaseApproval: () => void = () => undefined;
    const approvalReleased = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const consumed = new Promise<void>((resolve) => {
      handleCodexPlanDecisionCallbackMock.mockImplementationOnce(async (params) => {
        await params.onConsumed?.();
        resolve();
        await approvalReleased;
        return {
          handled: true,
          consumed: true,
          reply: { text: "implemented" },
        };
      });
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
    const slackRegistration = registerInteractiveHandler.mock.calls
      .map((call) => call[0])
      .find((registration) => registration?.channel === "slack");

    const reply = vi.fn(async () => undefined);
    const editMessage = vi.fn(async () => undefined);
    const handler = slackRegistration.handler({
      accountId: "default",
      senderId: "user-1",
      threadId: "thread-ts",
      auth: { isAuthorizedSender: true },
      interaction: { payload: "plan:token-1:approve" },
      respond: { reply, editMessage },
      requestConversationBinding: async () => ({ status: "error", message: "unused" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    await consumed;

    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledWith({ blocks: [] });
    expect(reply).toHaveBeenCalledWith({ text: "Sent answer to Codex." });
    expect(reply).not.toHaveBeenCalledWith({ text: "implemented" });

    releaseApproval();
    await expect(handler).resolves.toEqual({ handled: true });
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenLastCalledWith({ text: "implemented" });
  });

  it("keeps Discord Codex plan execution running when early acknowledgement fails", async () => {
    const registerInteractiveHandler = vi.fn();
    handleCodexPlanDecisionCallbackMock.mockImplementationOnce(async (params) => {
      await params.onConsumed?.();
      return {
        handled: true,
        consumed: true,
        reply: { text: "implemented" },
      };
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

    const reply = vi
      .fn()
      .mockRejectedValueOnce(new Error("ack expired"))
      .mockResolvedValueOnce(undefined);
    const clearComponents = vi.fn(async () => undefined);
    const disableComponents = vi.fn(async () => undefined);

    await expect(
      discordRegistration.handler({
        accountId: "default",
        senderId: "user-1",
        auth: { isAuthorizedSender: true },
        interaction: { payload: "plan:token-1:approve-clean" },
        respond: { reply, clearComponents, disableComponents },
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      }),
    ).resolves.toEqual({ handled: true });

    expect(disableComponents).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenNthCalledWith(1, {
      text: "Sent answer to Codex.",
      ephemeral: true,
    });
    expect(reply).toHaveBeenNthCalledWith(2, { text: "implemented", ephemeral: true });
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

    expect(sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Codex needs input:",
        payload: expect.objectContaining({
          text: "Codex needs input:",
          presentation: expect.objectContaining({
            blocks: [expect.objectContaining({ buttons: [expect.objectContaining({ label: "Plan" })] })],
          }),
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
