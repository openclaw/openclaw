import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandCatalogDecision,
  type PluginCommandDispatch,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("Slack native command argument menus", () => {
  let harness: ReturnType<typeof createArgMenusHarness>;
  let loginHandler: (args: unknown) => Promise<void>;
  let toolsHandler: (args: unknown) => Promise<void>;
  let ttsHandler: (args: unknown) => Promise<void>;
  let usageHandler: (args: unknown) => Promise<void>;
  let reportExternalHandler: (args: unknown) => Promise<void>;
  let reportLongHandler: (args: unknown) => Promise<void>;
  let reportLongButtonHandler: (args: unknown) => Promise<void>;
  let reportHugeButtonHandler: (args: unknown) => Promise<void>;
  let reportHugeValueHandler: (args: unknown) => Promise<void>;
  let unsafeConfirmHandler: (args: unknown) => Promise<void>;
  let longConfirmHandler: (args: unknown) => Promise<void>;
  let agentStatusHandler: (args: unknown) => Promise<void>;
  let argMenuHandler: (args: unknown) => Promise<void>;
  let argMenuOptionsHandler: (args: unknown) => Promise<void>;

  beforeAll(async () => {
    harness = createArgMenusHarness();
    await registerCommands(harness.ctx, harness.account);
    loginHandler = requireHandler(harness.commands, "/login", "/login");
    toolsHandler = requireHandler(harness.commands, "/tools", "/tools");
    ttsHandler = requireHandler(harness.commands, "/tts", "/tts");
    usageHandler = requireHandler(harness.commands, "/usage", "/usage");
    reportExternalHandler = requireHandler(harness.commands, "/reportexternal", "/reportexternal");
    reportLongHandler = requireHandler(harness.commands, "/reportlong", "/reportlong");
    reportLongButtonHandler = requireHandler(
      harness.commands,
      "/reportlongbutton",
      "/reportlongbutton",
    );
    reportHugeButtonHandler = requireHandler(
      harness.commands,
      "/reporthugebutton",
      "/reporthugebutton",
    );
    reportHugeValueHandler = requireHandler(
      harness.commands,
      "/reporthugevalue",
      "/reporthugevalue",
    );
    unsafeConfirmHandler = requireHandler(harness.commands, "/unsafeconfirm", "/unsafeconfirm");
    longConfirmHandler = requireHandler(harness.commands, "/longconfirm", "/longconfirm");
    agentStatusHandler = requireHandler(harness.commands, "/agentstatus", "/agentstatus");
    argMenuHandler = requireHandler(harness.actions, /^openclaw_cmdarg/, "arg-menu action");
    argMenuOptionsHandler = requireHandler(harness.options, "openclaw_cmdarg", "arg-menu options");
  });

  beforeEach(() => {
    harness.postEphemeral.mockClear();
    (harness.ctx as { dispatchReplyFromConfig?: unknown }).dispatchReplyFromConfig = undefined;
  });

  it("forwards the instance-bound reply dispatcher", async () => {
    const dispatchReplyFromConfig = vi.fn();
    (harness.ctx as { dispatchReplyFromConfig?: unknown }).dispatchReplyFromConfig =
      dispatchReplyFromConfig;

    await runCommandHandler(agentStatusHandler);

    const { turnPlanMock } = getSlackSlashMocks();
    expect(turnPlanMock).toHaveBeenCalledWith(expect.objectContaining({ dispatchReplyFromConfig }));
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
    const asyncDispatchMock = dispatchMock as unknown as {
      mockImplementation: (
        implementation: (params: unknown) => Promise<unknown>,
      ) => typeof dispatchMock;
    };
    asyncDispatchMock.mockImplementation(async (params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (
              payload: { text: string },
              info: { kind: "block" | "final" },
            ) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      await deliver({ text: "Use code ABCD" }, { kind: "block" });
      await loginFinished.promise;
      await deliver({ text: "Codex login complete." }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 1 } };
    });

    const runPromise = runCommandHandler(loginHandler);
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
    const asyncDispatchMock = dispatchMock as unknown as {
      mockImplementation: (
        implementation: (params: unknown) => Promise<unknown>,
      ) => typeof dispatchMock;
    };
    asyncDispatchMock.mockImplementation(async (params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (
              payload: { text: string },
              info: { kind: "block" | "final" },
            ) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      for (let index = 1; index <= 5; index += 1) {
        await deliver({ text: `progress ${String(index)}` }, { kind: "block" });
      }
      await deliver({ text: "final answer" }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 5 } };
    });

    await runCommandHandler(agentStatusHandler);

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

  it("batches accepted payloads in order while omitting a hook-cancelled payload", async () => {
    const { deliverSlackSlashRepliesMock, turnPlanMock } = getSlackSlashMocks();
    const asyncDispatchMock = dispatchMock as unknown as {
      mockImplementation: (
        implementation: (params: unknown) => Promise<unknown>,
      ) => typeof dispatchMock;
    };
    asyncDispatchMock.mockImplementation(async (params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
      const plan = turnPlanMock.mock.calls.at(-1)?.[0] as {
        delivery: {
          onDelivered?: (payload: unknown, info: unknown, result: unknown) => Promise<void> | void;
        };
      };
      await deliver({ text: "first" }, { kind: "final" });
      await plan.delivery.onDelivered?.(
        { text: "cancelled" },
        { kind: "final" },
        {
          visibleReplySent: false,
          suppression: { reason: "cancelled_by_reply_payload_sending_hook" },
        },
      );
      await deliver({ text: "third" }, { kind: "final" });
      return { counts: { final: 2, tool: 0, block: 0 } };
    });

    await runCommandHandler(agentStatusHandler);

    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledOnce();
    expect(deliverSlackSlashRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({ replies: [{ text: "first" }, { text: "third" }] }),
    );
  });

  it("does not call the response URL when every payload is hook-cancelled", async () => {
    const { deliverSlackSlashRepliesMock, turnPlanMock } = getSlackSlashMocks();
    const asyncDispatchMock = dispatchMock as unknown as {
      mockImplementation: (implementation: () => Promise<unknown>) => typeof dispatchMock;
    };
    asyncDispatchMock.mockImplementation(async () => {
      const plan = turnPlanMock.mock.calls.at(-1)?.[0] as {
        delivery: {
          onDelivered?: (payload: unknown, info: unknown, result: unknown) => Promise<void> | void;
        };
      };
      await plan.delivery.onDelivered?.(
        { text: "cancelled" },
        { kind: "final" },
        {
          visibleReplySent: false,
          suppression: { reason: "cancelled_by_reply_payload_sending_hook" },
        },
      );
      return { counts: { final: 0, tool: 0, block: 0 } };
    });

    await runCommandHandler(agentStatusHandler);

    expect(deliverSlackSlashRepliesMock).not.toHaveBeenCalled();
  });

  it("prefers the configured slash command over native commands", async () => {
    pluginCommandFixtures.specs = [
      { name: "slackplugin", description: "Plugin command", acceptsArgs: false },
    ];
    const configuredHarness = createArgMenusHarness();
    (
      configuredHarness.ctx as {
        slashCommand: { enabled: boolean };
      }
    ).slashCommand.enabled = true;
    const registration = await registerCommands(configuredHarness.ctx, configuredHarness.account);

    expect(registration).toEqual({ mode: "single", name: "openclaw" });
    expect(
      [...configuredHarness.commands.keys()].some(
        (command) => command instanceof RegExp && command.test("/openclaw"),
      ),
    ).toBe(true);
    expect(configuredHarness.commands.has("/usage")).toBe(false);
    expect(configuredHarness.actions.size).toBe(0);
    expect(configuredHarness.options.size).toBe(0);
  });

  it("registers unique plugin commands and silently keeps primary names on collision", async () => {
    pluginCommandFixtures.specs = [
      { name: "slackplugin", description: "Unique plugin command", acceptsArgs: false },
      { name: "reportlong", description: "Colliding plugin command", acceptsArgs: false },
    ];
    const testHarness = createArgMenusHarness();
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    testHarness.ctx.runtime = { log: runtimeLog, error: runtimeError };

    await registerCommands(testHarness.ctx, testHarness.account);

    expect(testHarness.commands.has("/slackplugin")).toBe(true);
    expect(testHarness.commandRegistrations.filter((name) => name === "/slackplugin")).toHaveLength(
      1,
    );
    expect(testHarness.commandRegistrations.filter((name) => name === "/reportlong")).toHaveLength(
      1,
    );
    expect(runtimeLog).not.toHaveBeenCalled();
    expect(runtimeError).not.toHaveBeenCalled();
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
    ];
    let selectedDispatch: PluginCommandDispatch | undefined;
    setAsyncDispatchMock(async ({ replyOptions }) => {
      const dispatch = replyOptions?.[PLUGIN_COMMAND_DISPATCH] as PluginCommandDispatch | undefined;
      expect(dispatch?.kind).toBe("plugin");
      selectedDispatch = dispatch;
      return { counts: { final: 1, tool: 0, block: 0 } };
    });
    const pluginHarness = createArgMenusHarness();
    await registerCommands(pluginHarness.ctx, pluginHarness.account);
    const handler = requireHandler(pluginHarness.commands, "/slackplugin", "plugin command");

    await handler({
      command: createSlashCommand({ text: "now please" }),
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

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

  it("filters a same-name plugin owned by another channel", async () => {
    const execute = vi.fn(async () => ({ text: "wrong channel" }));
    pluginCommandFixtures.specs = [
      {
        name: "reportlong",
        description: "Telegram-only plugin",
        acceptsArgs: false,
        channels: ["telegram"],
        execute,
      },
    ];
    const channelHarness = createArgMenusHarness();
    await registerCommands(channelHarness.ctx, channelHarness.account);

    await runCommandHandler(
      requireHandler(channelHarness.commands, "/reportlong", "report command"),
    );

    expect(execute).not.toHaveBeenCalled();
  });

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

  it("deduplicates a skill after the Slack status native rename", async () => {
    skillCommandFixtures.commands = [
      {
        name: "agentstatus",
        skillName: "Agent Status Skill",
        description: "Skill agent status",
      },
    ];
    const config: OpenClawConfig = { commands: { native: true, nativeSkills: true } };
    const testHarness = createArgMenusHarness(config);
    (testHarness.account as { config: OpenClawConfig }).config = config;

    await registerCommands(testHarness.ctx, testHarness.account);

    expect(testHarness.commandRegistrations.filter((name) => name === "/agentstatus")).toHaveLength(
      1,
    );
  });

  it.each([
    { agentRuntime: "codex", includesUltra: true },
    { agentRuntime: "openclaw", includesUltra: true },
  ] as const)(
    "renders runtime-specific /think choices for $agentRuntime",
    async ({ agentRuntime, includesUltra }) => {
      const testHarness = createArgMenusHarness({
        commands: { native: true, nativeSkills: false },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-luna" },
            models: {
              "openai/gpt-5.6-luna": { agentRuntime: { id: agentRuntime } },
            },
          },
        },
      });
      await registerCommands(testHarness.ctx, testHarness.account);
      const handler = requireHandler(testHarness.commands, "/think", "/think");

      const values = await getCommandArgMenuValues(handler);

      expect(values.length).toBeGreaterThan(0);
      expect(values.includes("ultra")).toBe(includesUltra);
    },
  );

  it("falls back to static menus when app.options() throws during registration", async () => {
    const testHarness = createArgMenusHarness();
    const runtimeLog = vi.fn();
    testHarness.ctx.runtime = { log: runtimeLog };
    testHarness.app.options = () => {
      throw new Error("Cannot read properties of undefined (reading 'listeners')");
    };

    // Registration should not throw despite app.options() throwing
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

    // The /reportexternal command (140 choices) should fall back to static_select
    // instead of external_select since options registration failed
    const handler = requireHandler(testHarness.commands, "/reportexternal", "/reportexternal");
    const respond = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      command: createSlashCommand(),
      ack,
      respond,
    });
    expect(respond).toHaveBeenCalledTimes(1);
    const payload = firstCallPayload(respond, "response") as {
      blocks?: Array<{ type: string }>;
    };
    const actionsBlock = findFirstActionsBlock(payload);
    // Should be static_select (fallback) not external_select
    expect(actionsBlock?.elements?.[0]?.type).toBe("static_select");
  });

  it("shows a button menu when required args are omitted", async () => {
    const { respond } = await runCommandHandler(toolsHandler);
    const actions = expectArgMenuLayout(respond);
    const elementType = actions?.elements?.[0]?.type;
    expect(elementType).toBe("button");
    expect(actions?.elements?.[0]?.action_id).toBe("openclaw_cmdarg_0_0");
    expect(actions?.elements?.[1]?.action_id).toBe("openclaw_cmdarg_0_1");
    expect(actions?.elements?.[0]).toHaveProperty("confirm");
  });

  it("shows a static_select menu when choices exceed button row size", async () => {
    const { respond } = await runCommandHandler(ttsHandler);
    const actions = expectArgMenuLayout(respond);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("static_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element).toHaveProperty("confirm");
  });

  it("uses static_select when encoded values fit Slack option limits", async () => {
    const firstElement = (await getFirstActionElementFromCommand(reportLongHandler)) as
      | {
          type?: string;
          options?: Array<{ value?: string }>;
          confirm?: unknown;
        }
      | undefined;
    expect(firstElement?.type).toBe("static_select");
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
    const firstElement = (await getFirstActionElementFromCommand(reportLongButtonHandler)) as
      | { type?: string; text?: { text?: string }; value?: string; confirm?: unknown }
      | undefined;
    expect(firstElement?.type).toBe("button");
    expect(firstElement?.text?.text).toHaveLength(75);
    expect(firstElement?.text?.text?.endsWith("…")).toBe(true);
    expect(firstElement?.value?.length).toBeGreaterThan(75);
    expect(firstElement).toHaveProperty("confirm");
  });

  it("caps large button fallback menus to Slack's block limit", async () => {
    const { respond } = await runCommandHandler(reportHugeButtonHandler);
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
    const { respond } = await runCommandHandler(reportHugeValueHandler);
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
  });

  it("shows an overflow menu when choices fit compact range", async () => {
    const element = await getFirstActionElementFromCommand(usageHandler);
    expect(element?.type).toBe("overflow");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element).toHaveProperty("confirm");
  });

  it("escapes only entities in confirm dialog text", async () => {
    const element = (await getFirstActionElementFromCommand(unsafeConfirmHandler)) as
      | { confirm?: { text?: { text?: string } } }
      | undefined;
    expect(element?.confirm?.text?.text).toContain(
      "Run */unsafeconfirm* with *mode_*`~&lt;&amp;&gt;* set to this value?",
    );
  });

  it("truncates confirm dialog text when long args force button fallback", async () => {
    const element = (await getFirstActionElementFromCommand(longConfirmHandler)) as
      | { type?: string; confirm?: { text?: { text?: string } } }
      | undefined;
    const confirmText = element?.confirm?.text?.text;
    expect(element?.type).toBe("button");
    expect(confirmText).toHaveLength(300);
    expect(confirmText?.endsWith("…")).toBe(true);
  });

  it("dispatches the command when a menu button is clicked", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "tools", arg: "mode", value: "compact", userId: "U1" }),
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = firstDispatchArg() as { ctx?: { Body?: string } };
    expect(call.ctx?.Body).toBe("/tools compact");
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
    { name: "top-level", message: undefined, threadTs: undefined },
    {
      name: "threaded",
      message: { ts: "171.222", thread_ts: "170.111" },
      threadTs: "170.111",
    },
  ])("does not cap $name Web API action replies", async ({ message, threadTs }) => {
    mockSixDispatchedReplies();

    await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      message,
      includeRespond: false,
    });

    expect(harness.postEphemeral).toHaveBeenCalledTimes(6);
    for (const [payload] of harness.postEphemeral.mock.calls) {
      expect(payload.thread_ts).toBe(threadTs);
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
    dispatchMock.mockImplementation((params: unknown) => {
      const deliver = (
        params as {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
          };
        }
      ).dispatcherOptions.deliver;
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

  it("keeps the response_url call cap on action responders", async () => {
    mockSixDispatchedReplies();

    const respond = await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      message: { ts: "171.222", thread_ts: "170.111" },
    });

    expect(respond).toHaveBeenCalledTimes(5);
    expect(harness.postEphemeral).not.toHaveBeenCalled();
  });

  it("keeps the response_url call cap on actual slash command replies", async () => {
    mockSixDispatchedReplies();

    const { respond } = await runCommandHandler(agentStatusHandler);

    expect(respond).toHaveBeenCalledTimes(5);
  });

  it("tracks accepted slash command activity", async () => {
    const trackingHarness = createArgMenusHarness();
    const trackEvent = vi.fn();
    await registerCommands(trackingHarness.ctx, trackingHarness.account, trackEvent);
    const usageTrackingHandler = requireHandler(trackingHarness.commands, "/usage", "/usage");

    await runCommandHandler(usageTrackingHandler);

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("maps /agentstatus to /status when dispatching", async () => {
    await runCommandHandler(agentStatusHandler);
    expectSingleDispatchedSlashBody("/status");
  });

  it("truncates served option labels on a surrogate boundary", async () => {
    const { respond, payload, blockId } =
      await runCommandAndResolveActionsBlock(reportExternalHandler);
    expect(respond).toHaveBeenCalledTimes(1);
    const element = findFirstActionsBlock(payload)?.elements?.[0];
    expect(element?.type).toBe("external_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(blockId).toMatch(/^openclaw_cmdarg_ext:[A-Za-z0-9_-]{24}$/);
    expect(harness.optionsReceiverContexts[0]).toBe(harness.app);

    const ackOptions = vi.fn().mockResolvedValue(undefined);
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        user: { id: "U1" },
        value: "emojioverflow",
        actions: [{ block_id: blockId }],
      },
    });

    expect(ackOptions).toHaveBeenCalledTimes(1);
    const optionsPayload = firstCallPayload(ackOptions, "options ack") as {
      options?: Array<{ text?: { text?: string }; value?: string }>;
    };
    // The "emojioverflow" query matches only the long emoji label, so exactly one
    // option is served.
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

  it("tracks accepted external_select option requests", async () => {
    const trackingHarness = createArgMenusHarness();
    const trackEvent = vi.fn();
    await registerCommands(trackingHarness.ctx, trackingHarness.account, trackEvent);
    const reportExternalTrackingHandler = requireHandler(
      trackingHarness.commands,
      "/reportexternal",
      "/reportexternal",
    );
    const argMenuOptionsTrackingHandler = requireHandler(
      trackingHarness.options,
      "openclaw_cmdarg",
      "arg-menu options",
    );
    const { blockId } = await runCommandAndResolveActionsBlock(reportExternalTrackingHandler);
    const ackOptions = vi.fn().mockResolvedValue(undefined);
    trackEvent.mockClear();

    await argMenuOptionsTrackingHandler({
      ack: ackOptions,
      body: {
        user: { id: "U1" },
        value: "period 12",
        actions: [{ block_id: blockId }],
      },
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects external_select option requests without user identity", async () => {
    const { blockId } = await runCommandAndResolveActionsBlock(reportExternalHandler);
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

  it("tracks accepted arg-menu actions", async () => {
    const trackingHarness = createArgMenusHarness();
    const trackEvent = vi.fn();
    await registerCommands(trackingHarness.ctx, trackingHarness.account, trackEvent);
    const argMenuTrackingHandler = requireHandler(
      trackingHarness.actions,
      /^openclaw_cmdarg/,
      "arg-menu action",
    );

    await runArgMenuAction(argMenuTrackingHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
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
