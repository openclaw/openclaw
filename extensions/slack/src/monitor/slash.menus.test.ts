import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandCatalogDecision,
  type PluginCommandDispatch,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createArgMenusHarness,
  createSlashCommand,
  encodeValue,
  expectArgMenuLayout,
  expectSingleDispatchedSlashBody,
  findFirstActionsBlock,
  firstDispatchArg,
  getCommandArgMenuValues,
  getFirstActionElementFromCommand,
  getSlackCommandFixtures,
  mockSixDispatchedReplies,
  registerCommands,
  requireHandler,
  runArgMenuAction,
  runCommandAndResolveActionsBlock,
  runCommandHandler,
  setAsyncDispatchMock,
} from "./slash.commands.test-harness.js";
import { firstCallPayload, getSlackSlashMocks } from "./slash.test-harness.js";

const { dispatchMock } = getSlackSlashMocks();
const { pluginCommandFixtures, skillCommandFixtures } = getSlackCommandFixtures();
type DispatchParams = {
  dispatcherOptions: {
    deliver: (payload: { text: string }, info: { kind: "block" | "final" }) => Promise<void>;
  };
};

describe("Slack native command argument menus", () => {
  let harness: ReturnType<typeof createArgMenusHarness>;
  let argMenuHandler: (args: unknown) => Promise<void>;
  let argMenuOptionsHandler: (args: unknown) => Promise<void>;
  const trackEvent = vi.fn();
  const command = (name: string) => requireHandler(harness.commands, `/${name}`, `/${name}`);

  beforeAll(async () => {
    harness = createArgMenusHarness();
    await registerCommands(harness.ctx, harness.account, trackEvent);
    argMenuHandler = requireHandler(harness.actions, /^openclaw_cmdarg/, "arg-menu action");
    argMenuOptionsHandler = requireHandler(harness.options, "openclaw_cmdarg", "arg-menu options");
  });

  beforeEach(() => {
    trackEvent.mockClear();
    harness.postEphemeral.mockClear();
    (harness.ctx as { dispatchReplyFromConfig?: unknown }).dispatchReplyFromConfig = undefined;
  });

  it("delivers native /login block replies before the command finishes", async () => {
    const loginFinished = createDeferred<void>();
    const codeDelivered = createDeferred<void>();
    const { deliverSlackSlashRepliesMock } = getSlackSlashMocks();
    deliverSlackSlashRepliesMock.mockImplementation(async (params: unknown) => {
      const replies = (params as { replies: Array<{ text?: string }> }).replies;
      if (replies.some((reply) => reply.text === "Use code ABCD")) {
        codeDelivered.resolve();
      }
    });
    dispatchMock.mockImplementation(async ({ dispatcherOptions: { deliver } }: DispatchParams) => {
      await deliver({ text: "Use code ABCD" }, { kind: "block" });
      await loginFinished.promise;
      await deliver({ text: "Codex login complete." }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 1 } };
    });

    const runPromise = runCommandHandler(command("login"));
    await codeDelivered.promise;
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledOnce();
    expect(deliverSlackSlashRepliesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ replies: [{ text: "Use code ABCD" }] }),
    );

    loginFinished.resolve();
    await runPromise;
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledTimes(2);
    expect(deliverSlackSlashRepliesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ replies: [{ text: "Codex login complete." }] }),
    );
  });

  it("batches non-login block streams with the terminal reply", async () => {
    const { deliverSlackSlashRepliesMock } = getSlackSlashMocks();
    dispatchMock.mockImplementation(async ({ dispatcherOptions: { deliver } }: DispatchParams) => {
      for (let index = 1; index <= 5; index += 1) {
        await deliver({ text: `progress ${String(index)}` }, { kind: "block" });
      }
      await deliver({ text: "final answer" }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 5 } };
    });

    await runCommandHandler(command("agentstatus"));

    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledOnce();
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          { text: "progress 1" },
          { text: "progress 2" },
          { text: "progress 3" },
          { text: "progress 4" },
          { text: "progress 5" },
          { text: "final answer" },
        ],
      }),
    );
  });

  it("prefers the configured slash command over native commands", async () => {
    pluginCommandFixtures.specs = [
      { name: "slackplugin", description: "Plugin command", acceptsArgs: false },
    ];
    const configuredHarness = createArgMenusHarness();
    configuredHarness.ctx.slashCommand.enabled = true;
    const registration = await registerCommands(configuredHarness.ctx, configuredHarness.account);

    expect(registration).toEqual({ mode: "single", name: "openclaw" });
    expect(
      [...configuredHarness.commands.keys()].some(
        (matcher) => matcher instanceof RegExp && matcher.test("/openclaw"),
      ),
    ).toBe(true);
    expect(configuredHarness.commands.has("/usage")).toBe(false);
    expect(configuredHarness.actions.size).toBe(0);
    expect(configuredHarness.options.size).toBe(0);
  });

  it("executes the exact selected plugin candidate with its native arguments", async () => {
    const execute = vi.fn(async (args?: string) => ({ text: `plugin:${args}` }));
    pluginCommandFixtures.specs = [
      {
        name: "slackplugin",
        description: "Unique plugin command",
        acceptsArgs: true,
        execute,
      },
      { name: "reportlong", description: "Colliding plugin command", acceptsArgs: false },
    ];
    let selectedDispatch: PluginCommandDispatch | undefined;
    setAsyncDispatchMock(async ({ replyOptions }) => {
      const dispatch = replyOptions?.[PLUGIN_COMMAND_DISPATCH] as PluginCommandDispatch | undefined;
      expect(dispatch?.kind).toBe("plugin");
      selectedDispatch = dispatch;
      return { counts: { final: 1, tool: 0, block: 0 } };
    });
    const pluginHarness = createArgMenusHarness();
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    pluginHarness.ctx.runtime = { log: runtimeLog, error: runtimeError };
    await registerCommands(pluginHarness.ctx, pluginHarness.account);
    expect(pluginHarness.commands.has("/slackplugin")).toBe(true);
    for (const name of ["/slackplugin", "/reportlong"]) {
      expect(
        pluginHarness.commandRegistrations.filter((registered) => registered === name),
      ).toHaveLength(1);
    }
    expect(runtimeLog).not.toHaveBeenCalled();
    expect(runtimeError).not.toHaveBeenCalled();
    const handler = requireHandler(pluginHarness.commands, "/slackplugin", "plugin command");

    await runCommandHandler(handler, { text: "now please" });

    expect(selectedDispatch).toBeDefined();
    await selectedDispatch!.execute({
      channel: "slack",
      isAuthorizedSender: true,
      commandBody: "/slackplugin now please",
      config: {},
    });
    expect(execute).toHaveBeenCalledWith("now please");
  });

  it.each(["login", "reportlong"])(
    "does not execute a plugin skipped behind the primary /%s command",
    async (name) => {
      const execute = vi.fn(async () => ({ text: "wrong owner" }));
      pluginCommandFixtures.specs = [
        { name, description: "Skipped plugin", acceptsArgs: false, execute },
      ];
      let selectedDispatch: PluginCommandCatalogDecision | undefined;
      setAsyncDispatchMock(async ({ replyOptions }) => {
        selectedDispatch = replyOptions?.[PLUGIN_COMMAND_DISPATCH] as
          | PluginCommandCatalogDecision
          | undefined;
        return { counts: { final: 1, tool: 0, block: 0 } };
      });
      const collisionHarness = createArgMenusHarness();
      await registerCommands(collisionHarness.ctx, collisionHarness.account);
      const handler = requireHandler(collisionHarness.commands, `/${name}`, `${name} command`);

      await runCommandHandler(handler, { text: name === "reportlong" ? "day" : "" });

      expect(selectedDispatch).toEqual({ kind: "non-plugin" });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["same name", "skill-only"],
    ["dash/underscore", "foo-bar"],
  ])("keeps the selected route skill for a %s plugin collision", async (_label, pluginName) => {
    const skillName = pluginName === "foo-bar" ? "foo_bar" : pluginName;
    skillCommandFixtures.commands = [
      { name: skillName, skillName: "Selected Skill", description: "Selected skill" },
    ];
    const execute = vi.fn(async () => ({ text: "wrong owner" }));
    pluginCommandFixtures.specs = [
      { name: pluginName, description: "Colliding plugin", acceptsArgs: false, execute },
    ];
    let selectedDispatch: PluginCommandCatalogDecision | undefined;
    setAsyncDispatchMock(async ({ replyOptions }) => {
      selectedDispatch = replyOptions?.[PLUGIN_COMMAND_DISPATCH] as
        | PluginCommandCatalogDecision
        | undefined;
      return { counts: { final: 1, tool: 0, block: 0 } };
    });
    const skillHarness = createArgMenusHarness({ commands: { native: true, nativeSkills: true } });
    (skillHarness.account as { config: OpenClawConfig }).config = {
      commands: { native: true, nativeSkills: true },
    };
    await registerCommands(skillHarness.ctx, skillHarness.account);

    await runCommandHandler(
      requireHandler(skillHarness.commands, `/${skillName}`, "skill command"),
    );

    expect(selectedDispatch).toEqual({ kind: "non-plugin" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["config", "parent"])("renders /think choices from the %s model", async (source) => {
    const parentKey = "agent:main:slack:channel:c1";
    const sessionKey = `${parentKey}:thread:100`;
    if (source === "parent") {
      const reader = vi
        .spyOn(sessionStore, "getSessionEntryAsync")
        .mockImplementation(async (params) =>
          params.sessionKey === parentKey
            ? {
                sessionId: "parent",
                updatedAt: 1,
                providerOverride: "openai",
                modelOverride: "gpt-5.6-luna",
              }
            : undefined,
        );
      onTestFinished(() => reader.mockRestore());
      getSlackSlashMocks().resolveAgentRouteMock.mockReturnValue({
        agentId: "main",
        sessionKey,
        accountId: "acct",
      });
    }
    const testHarness = createArgMenusHarness({
      commands: { native: true, nativeSkills: false },
      agents: {
        defaults: {
          model: { primary: source === "parent" ? "openai/gpt-5.4" : "openai/gpt-5.6-luna" },
          models: {
            "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
          },
        },
      },
    });
    await registerCommands(testHarness.ctx, testHarness.account);
    const handler = requireHandler(testHarness.commands, "/think", "/think");

    const values = await getCommandArgMenuValues(handler);

    expect(values.length).toBeGreaterThan(0);
    expect(values).toContain("ultra");
    if (source === "parent") {
      expect(sessionStore.getSessionEntryAsync).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", sessionKey: parentKey }),
      );
    }
  });

  it("falls back to static menus when app.options() throws during registration", async () => {
    const testHarness = createArgMenusHarness();
    const runtimeLog = vi.fn();
    testHarness.ctx.runtime = { log: runtimeLog };
    testHarness.app.options = () => {
      throw new Error("Cannot read properties of undefined (reading 'listeners')");
    };

    await registerCommands(testHarness.ctx, testHarness.account);
    expect(testHarness.commands.size).toBeGreaterThan(0);
    expect(runtimeLog).toHaveBeenCalledTimes(1);
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "slack: external arg-menu registration failed; falling back to static slash command menus.",
      ),
    );
    expect(
      Array.from(testHarness.actions.keys()).some(
        (key) => key instanceof RegExp && String(key) === String(/^openclaw_cmdarg/),
      ),
    ).toBe(true);

    const handler = requireHandler(testHarness.commands, "/reportexternal", "/reportexternal");
    const { respond } = await runCommandHandler(handler);
    expect(respond).toHaveBeenCalledTimes(1);
    const payload = firstCallPayload(respond, "response") as {
      blocks?: Array<{ type: string }>;
    };
    const actionsBlock = findFirstActionsBlock(payload);
    expect(actionsBlock?.elements?.[0]?.type).toBe("static_select");
  });

  it.each([
    { name: "tools", type: "button" },
    { name: "usage", type: "overflow" },
  ])("renders the $type argument menu for /$name", async ({ name, type }) => {
    const { respond } = await runCommandHandler(command(name));
    const actions = expectArgMenuLayout(respond);
    const element = actions.elements?.[0];
    expect(element?.type).toBe(type);
    expect(element).toHaveProperty("confirm");
    expect(getSlackSlashMocks().recordDeliveredCommandExchangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "session:1",
        commandText: `/${name}`,
        commandId: expect.stringMatching(/^slack:/),
        replyId: "argument-menu",
      }),
    );
    expect(
      getSlackSlashMocks().recordDeliveredCommandExchangeMock.mock.calls[0]?.[0].replyText,
    ).toContain(firstCallPayload(respond, "menu").text);
    expect(
      getSlackSlashMocks().recordDeliveredCommandExchangeMock.mock.calls[0]?.[0].replyText,
    ).not.toContain("openclaw_cmdarg");
    if (type === "button") {
      expect(element?.action_id).toBe("openclaw_cmdarg_0_0");
      expect(actions.elements?.[1]?.action_id).toBe("openclaw_cmdarg_0_1");
      await runArgMenuAction(argMenuHandler, {
        action: {
          value: encodeValue({ command: name, arg: "mode", value: "compact", userId: "U1" }),
        },
      });
      expectSingleDispatchedSlashBody("/tools compact");
    } else {
      expect(
        getSlackSlashMocks().recordDeliveredCommandExchangeMock.mock.calls[0]?.[0].replyText,
      ).toContain("tokens");
      expect(element?.action_id).toBe("openclaw_cmdarg");
    }
  });

  it("does not retain an argument menu when Slack rejects delivery", async () => {
    const respond = vi
      .fn()
      .mockRejectedValueOnce(new Error("delivery rejected"))
      .mockResolvedValue(undefined);
    await command("tools")({
      command: createSlashCommand(),
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(getSlackSlashMocks().recordDeliveredCommandExchangeMock).not.toHaveBeenCalled();
  });

  it("uses static_select when encoded values fit Slack option limits", async () => {
    const { respond } = await runCommandHandler(command("reportlong"));
    const firstElement = expectArgMenuLayout(respond).elements?.[0] as
      | {
          type?: string;
          action_id?: string;
          options?: Array<{ value?: string }>;
          confirm?: unknown;
        }
      | undefined;
    expect(firstElement?.type).toBe("static_select");
    expect(firstElement?.action_id).toBe("openclaw_cmdarg");
    const longOption = firstElement?.options?.find((option) => option.value?.includes("xxx"));
    expect(longOption?.value?.length).toBeGreaterThan(75);
    expect(longOption?.value?.length).toBeLessThanOrEqual(150);
    expect(firstElement).toHaveProperty("confirm");
    await runArgMenuAction(argMenuHandler, {
      action: { selected_option: firstElement?.options?.[0] },
    });
    expectSingleDispatchedSlashBody("/reportlong day");
  });

  it("truncates button labels when static_select value limit would be exceeded", async () => {
    const firstElement = (await getFirstActionElementFromCommand(command("reportlongbutton"))) as
      | { type?: string; text?: { text?: string }; value?: string; confirm?: unknown }
      | undefined;
    expect(firstElement?.type).toBe("button");
    expect(firstElement?.text?.text).toHaveLength(75);
    expect(firstElement?.text?.text?.endsWith("…")).toBe(true);
    expect(firstElement?.value?.length).toBeGreaterThan(75);
    expect(firstElement).toHaveProperty("confirm");
    const recorded = getSlackSlashMocks().recordDeliveredCommandExchangeMock.mock.calls.at(-1)?.[0];
    expect(recorded?.replyText).toContain(firstElement?.text?.text);
    expect(recorded?.replyText).not.toContain("Long button label ".repeat(8));
  });

  it("caps large button fallback menus to Slack's block limit", async () => {
    const { respond } = await runCommandHandler(command("reporthugebutton"));
    expect(respond).toHaveBeenCalledTimes(1);
    const payload = firstCallPayload(respond, "response") as {
      blocks?: Array<{ type: string; elements?: unknown[] }>;
    };
    const actionBlocks = (payload.blocks ?? []).filter((block) => block.type === "actions");
    expect(payload.blocks).toHaveLength(50);
    expect(actionBlocks).toHaveLength(47);
    expect(actionBlocks.at(-1)?.elements).toHaveLength(5);
  });

  it("drops fallback buttons whose encoded values exceed Slack's button value limit", async () => {
    const { respond } = await runCommandHandler(command("reporthugevalue"));
    expect(respond).toHaveBeenCalledTimes(1);
    const payload = firstCallPayload(respond, "response") as {
      blocks?: Array<{
        type: string;
        elements?: Array<{ text?: { text?: string }; value?: string }>;
      }>;
    };
    const actionBlocks = (payload.blocks ?? []).filter((block) => block.type === "actions");
    expect(actionBlocks).toHaveLength(1);
    expect(actionBlocks[0]?.elements).toHaveLength(1);
    const element = actionBlocks[0]?.elements?.[0];
    expect(element?.text?.text).toBe("Valid");
    expect(element?.value?.length).toBeLessThanOrEqual(2000);
    const recorded = getSlackSlashMocks().recordDeliveredCommandExchangeMock.mock.calls.at(-1)?.[0];
    expect(recorded?.replyText).toContain("Valid");
    expect(recorded?.replyText).not.toContain("Overlong");
  });

  it("escapes only entities in confirm dialog text", async () => {
    const element = (await getFirstActionElementFromCommand(command("unsafeconfirm"))) as
      | { confirm?: { text?: { text?: string } } }
      | undefined;
    expect(element?.confirm?.text?.text).toContain(
      "Run */unsafeconfirm* with *mode_*`~&lt;&amp;&gt;* set to this value?",
    );
  });

  it("truncates confirm dialog text when long args force button fallback", async () => {
    const element = (await getFirstActionElementFromCommand(command("longconfirm"))) as
      | { type?: string; confirm?: { text?: { text?: string } } }
      | undefined;
    const confirmText = element?.confirm?.text?.text;
    expect(element?.type).toBe("button");
    expect(confirmText).toHaveLength(300);
    expect(confirmText?.endsWith("…")).toBe(true);
  });

  it("keeps the Enterprise Grid team on deferred argument-menu actions", async () => {
    const enterpriseHarness = createArgMenusHarness(
      { commands: { native: true, nativeSkills: false } },
      {
        installationIdentity: { kind: "enterprise", enterpriseId: "EGRID" },
        teamId: "TGRID1",
      },
    );
    await registerCommands(enterpriseHarness.ctx, enterpriseHarness.account);
    const enterpriseArgMenuHandler = requireHandler(
      enterpriseHarness.actions,
      /^openclaw_cmdarg/,
      "Enterprise arg-menu action",
    );

    await runArgMenuAction(enterpriseArgMenuHandler, {
      action: {
        value: encodeValue({ command: "tools", arg: "mode", value: "compact", userId: "U1" }),
      },
    });

    expect(getSlackSlashMocks().resolveAgentRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "TGRID1",
        peer: { kind: "direct", id: "team:TGRID1:user:U1" },
      }),
    );
    expect(firstDispatchArg().ctx?.OriginatingTo).toBe("team:TGRID1:user:U1");
  });

  it.each([
    ["threaded Web API", "action", true, { ts: "171.222", thread_ts: "170.111" }, "170.111"],
    ["action response URL", "action", false, { ts: "171.222", thread_ts: "170.111" }, "170.111"],
    ["slash response URL", "slash", false, undefined, undefined],
  ] as const)("preserves the %s reply budget", async (_name, source, webApi, message, threadTs) => {
    mockSixDispatchedReplies();
    const dispatchReplyFromConfig = vi.fn();
    if (source === "slash") {
      (harness.ctx as { dispatchReplyFromConfig?: unknown }).dispatchReplyFromConfig =
        dispatchReplyFromConfig;
    }
    const respond =
      source === "slash"
        ? (await runCommandHandler(command("agentstatus"))).respond
        : await runArgMenuAction(argMenuHandler, {
            action: {
              value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
            },
            message,
            includeRespond: !webApi,
          });
    expect(trackEvent).toHaveBeenCalledTimes(1);
    if (webApi) {
      expect(harness.postEphemeral).toHaveBeenCalledTimes(6);
      for (const [payload] of harness.postEphemeral.mock.calls) {
        expect(payload.thread_ts).toBe(threadTs);
      }
    } else {
      expect(respond).toHaveBeenCalledTimes(5);
      expect(harness.postEphemeral).not.toHaveBeenCalled();
    }
    if (source === "slash") {
      expectSingleDispatchedSlashBody("/status");
      expect(getSlackSlashMocks().turnPlanMock).toHaveBeenCalledWith(
        expect.objectContaining({ dispatchReplyFromConfig }),
      );
    }
  });

  it("keeps Web API action replies ephemeral and table fallback tokens literal", async () => {
    const tableFallback = "Account\tOwner\nprod\t<@U123> & <!channel>";
    const { deliverSlackSlashRepliesMock } = getSlackSlashMocks();
    deliverSlackSlashRepliesMock.mockImplementation(async (params: unknown) => {
      const responseBudget = (
        params as {
          responseBudget: {
            respond: (payload: {
              text: string;
              mrkdwn?: false;
              response_type: "in_channel";
            }) => Promise<unknown>;
          };
        }
      ).responseBudget;
      await responseBudget.respond({
        text: tableFallback,
        mrkdwn: false,
        response_type: "in_channel",
      });
    });
    dispatchMock.mockImplementation(({ dispatcherOptions: { deliver } }: DispatchParams) => {
      void deliver({ text: "table reply" }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 0 } };
    });

    await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      includeRespond: false,
    });

    expect(harness.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: tableFallback, mrkdwn: false }),
    );
  });

  it("truncates served option labels on a surrogate boundary", async () => {
    const { respond, payload, blockId } = await runCommandAndResolveActionsBlock(
      command("reportexternal"),
    );
    expect(respond).toHaveBeenCalledTimes(1);
    const element = findFirstActionsBlock(payload)?.elements?.[0];
    expect(element?.type).toBe("external_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(blockId).toMatch(/^openclaw_cmdarg_ext:[A-Za-z0-9_-]{24}$/);
    expect(harness.optionsReceiverContexts[0]).toBe(harness.app);

    const ackOptions = vi.fn().mockResolvedValue(undefined);
    trackEvent.mockClear();
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        user: { id: "U1" },
        value: "emojioverflow",
        actions: [{ block_id: blockId }],
      },
    });

    expect(ackOptions).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledTimes(1);
    const optionsPayload = firstCallPayload(ackOptions, "options ack") as {
      options?: Array<{ text?: { text?: string }; value?: string }>;
    };
    const served = optionsPayload.options ?? [];
    expect(served).toHaveLength(1);
    expect(decodeURIComponent(served[0]?.value?.split("|")[3] ?? "")).toBe("emoji-overflow");
    const text = served[0]?.text?.text ?? "";
    // Plain_text option labels are capped at 75 chars and must not end on a lone
    // surrogate half, which Slack rejects. The label was long enough to truncate.
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(75);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text),
    ).toBe(false);
  });

  it("rejects external_select option requests without user identity", async () => {
    const { blockId } = await runCommandAndResolveActionsBlock(command("reportexternal"));
    expect(blockId).toContain("openclaw_cmdarg_ext:");

    const ackOptions = vi.fn().mockResolvedValue(undefined);
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        value: "period 1",
        actions: [{ block_id: blockId }],
      },
    });

    expect(ackOptions).toHaveBeenCalledTimes(1);
    expect(ackOptions).toHaveBeenCalledWith({ options: [] });
  });

  it("rejects menu clicks from other users", async () => {
    const respond = await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      userId: "U2",
      userName: "Eve",
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "That menu is for another user.",
      response_type: "ephemeral",
    });
  });

  it.each([
    { name: "a top-level action", message: undefined, container: undefined, threadTs: undefined },
    {
      name: "the action container's parent thread",
      message: { ts: "171.222", thread_ts: "169.999" },
      container: { message_ts: "171.222", thread_ts: "170.111" },
      threadTs: "170.111",
    },
    {
      name: "the action message's parent thread",
      message: { ts: "171.222", thread_ts: "170.111" },
      container: { message_ts: "171.222" },
      threadTs: "170.111",
    },
  ])(
    "keeps $name when respond falls back to postEphemeral",
    async ({ message, container, threadTs }) => {
      await runArgMenuAction(argMenuHandler, {
        action: { value: "garbage" },
        message,
        container,
        includeRespond: false,
      });

      const payload = firstCallPayload(harness.postEphemeral, "postEphemeral");
      expect(payload.token).toBe("bot-token");
      expect(payload.channel).toBe("C1");
      expect(payload.user).toBe("U1");
      expect(payload.thread_ts).toBe(threadTs);
    },
  );

  it("treats malformed percent-encoding as an invalid button", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: { value: "cmdarg|%E0%A4%A|mode|on|U1" },
      includeRespond: false,
    });

    const payload = firstCallPayload(harness.postEphemeral, "postEphemeral");
    expect(payload.token).toBe("bot-token");
    expect(payload.channel).toBe("C1");
    expect(payload.user).toBe("U1");
    expect(payload.text).toBe("Sorry, that button is no longer valid.");
  });
});
