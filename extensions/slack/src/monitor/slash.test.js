import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackSlashMocks, resetSlackSlashMocks } from "./slash.test-harness.js";
vi.mock("../../../../src/auto-reply/commands-registry.js", () => {
  const usageCommand = { key: "usage", nativeName: "usage" };
  const reportCommand = { key: "report", nativeName: "report" };
  const reportCompactCommand = { key: "reportcompact", nativeName: "reportcompact" };
  const reportExternalCommand = { key: "reportexternal", nativeName: "reportexternal" };
  const reportLongCommand = { key: "reportlong", nativeName: "reportlong" };
  const unsafeConfirmCommand = { key: "unsafeconfirm", nativeName: "unsafeconfirm" };
  const statusAliasCommand = { key: "status", nativeName: "status" };
  const periodArg = { name: "period", description: "period" };
  const baseReportPeriodChoices = [
    { value: "day", label: "day" },
    { value: "week", label: "week" },
    { value: "month", label: "month" },
    { value: "quarter", label: "quarter" }
  ];
  const fullReportPeriodChoices = [...baseReportPeriodChoices, { value: "year", label: "year" }];
  const hasNonEmptyArgValue = (values, key) => {
    const raw = typeof values === "object" && values !== null ? values[key] : void 0;
    return typeof raw === "string" && raw.trim().length > 0;
  };
  const resolvePeriodMenu = (params, choices) => {
    if (hasNonEmptyArgValue(params.args?.values, "period")) {
      return null;
    }
    return { arg: periodArg, choices };
  };
  return {
    buildCommandTextFromArgs: (cmd, args) => {
      const name = cmd.nativeName ?? cmd.key;
      const values = args?.values ?? {};
      const mode = values.mode;
      const period = values.period;
      const selected = typeof mode === "string" && mode.trim() ? mode.trim() : typeof period === "string" && period.trim() ? period.trim() : "";
      return selected ? `/${name} ${selected}` : `/${name}`;
    },
    findCommandByNativeName: (name) => {
      const normalized = name.trim().toLowerCase();
      if (normalized === "usage") {
        return usageCommand;
      }
      if (normalized === "report") {
        return reportCommand;
      }
      if (normalized === "reportcompact") {
        return reportCompactCommand;
      }
      if (normalized === "reportexternal") {
        return reportExternalCommand;
      }
      if (normalized === "reportlong") {
        return reportLongCommand;
      }
      if (normalized === "unsafeconfirm") {
        return unsafeConfirmCommand;
      }
      if (normalized === "agentstatus") {
        return statusAliasCommand;
      }
      return void 0;
    },
    listNativeCommandSpecsForConfig: () => [
      {
        name: "usage",
        description: "Usage",
        acceptsArgs: true,
        args: []
      },
      {
        name: "report",
        description: "Report",
        acceptsArgs: true,
        args: []
      },
      {
        name: "reportcompact",
        description: "ReportCompact",
        acceptsArgs: true,
        args: []
      },
      {
        name: "reportexternal",
        description: "ReportExternal",
        acceptsArgs: true,
        args: []
      },
      {
        name: "reportlong",
        description: "ReportLong",
        acceptsArgs: true,
        args: []
      },
      {
        name: "unsafeconfirm",
        description: "UnsafeConfirm",
        acceptsArgs: true,
        args: []
      },
      {
        name: "agentstatus",
        description: "Status",
        acceptsArgs: false,
        args: []
      }
    ],
    parseCommandArgs: () => ({ values: {} }),
    resolveCommandArgMenu: (params) => {
      if (params.command?.key === "report") {
        return resolvePeriodMenu(params, [
          ...fullReportPeriodChoices,
          { value: "all", label: "all" }
        ]);
      }
      if (params.command?.key === "reportlong") {
        return resolvePeriodMenu(params, [
          ...fullReportPeriodChoices,
          { value: "x".repeat(90), label: "long" }
        ]);
      }
      if (params.command?.key === "reportcompact") {
        return resolvePeriodMenu(params, baseReportPeriodChoices);
      }
      if (params.command?.key === "reportexternal") {
        return {
          arg: { name: "period", description: "period" },
          choices: Array.from({ length: 140 }, (_v, i) => ({
            value: `period-${i + 1}`,
            label: `Period ${i + 1}`
          }))
        };
      }
      if (params.command?.key === "unsafeconfirm") {
        return {
          arg: { name: "mode_*`~<&>", description: "mode" },
          choices: [
            { value: "on", label: "on" },
            { value: "off", label: "off" }
          ]
        };
      }
      if (params.command?.key !== "usage") {
        return null;
      }
      const values = params.args?.values ?? {};
      if (typeof values.mode === "string" && values.mode.trim()) {
        return null;
      }
      return {
        arg: { name: "mode", description: "mode" },
        choices: [
          { value: "tokens", label: "tokens" },
          { value: "cost", label: "cost" }
        ]
      };
    }
  };
});
let registerSlackMonitorSlashCommands;
const { dispatchMock } = getSlackSlashMocks();
beforeAll(async () => {
  ({ registerSlackMonitorSlashCommands } = await import("./slash.js"));
});
beforeEach(() => {
  resetSlackSlashMocks();
});
async function registerCommands(ctx, account) {
  await registerSlackMonitorSlashCommands({ ctx, account });
}
function encodeValue(parts) {
  return [
    "cmdarg",
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId)
  ].join("|");
}
function findFirstActionsBlock(payload) {
  return payload.blocks?.find((block) => block.type === "actions");
}
function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
function createArgMenusHarness() {
  const commands = /* @__PURE__ */ new Map();
  const actions = /* @__PURE__ */ new Map();
  const options = /* @__PURE__ */ new Map();
  const optionsReceiverContexts = [];
  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const app = {
    client: { chat: { postEphemeral } },
    command: (name, handler) => {
      commands.set(name, handler);
    },
    action: (id, handler) => {
      actions.set(id, handler);
    },
    options: function(id, handler) {
      optionsReceiverContexts.push(this);
      options.set(id, handler);
    }
  };
  const ctx = {
    cfg: { commands: { native: true, nativeSkills: false } },
    runtime: {},
    botToken: "bot-token",
    botUserId: "bot",
    teamId: "T1",
    allowFrom: ["*"],
    dmEnabled: true,
    dmPolicy: "open",
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: "open",
    useAccessGroups: false,
    channelsConfig: void 0,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash"
    },
    textLimit: 4e3,
    app,
    isChannelAllowed: () => true,
    resolveChannelName: async () => ({ name: "dm", type: "im" }),
    resolveUserName: async () => ({ name: "Ada" })
  };
  const account = {
    accountId: "acct",
    config: { commands: { native: true, nativeSkills: false } }
  };
  return {
    commands,
    actions,
    options,
    optionsReceiverContexts,
    postEphemeral,
    ctx,
    account,
    app
  };
}
function requireHandler(handlers, key, label) {
  const handler = handlers.get(key);
  if (!handler) {
    throw new Error(`Missing ${label} handler`);
  }
  return handler;
}
function createSlashCommand(overrides = {}) {
  return {
    user_id: "U1",
    user_name: "Ada",
    channel_id: "C1",
    channel_name: "directmessage",
    text: "",
    trigger_id: "t1",
    ...overrides
  };
}
async function runCommandHandler(handler) {
  const respond = vi.fn().mockResolvedValue(void 0);
  const ack = vi.fn().mockResolvedValue(void 0);
  await handler({
    command: createSlashCommand(),
    ack,
    respond
  });
  return { respond, ack };
}
function expectArgMenuLayout(respond) {
  expect(respond).toHaveBeenCalledTimes(1);
  const payload = respond.mock.calls[0]?.[0];
  expect(payload.blocks?.[0]?.type).toBe("header");
  expect(payload.blocks?.[1]?.type).toBe("section");
  expect(payload.blocks?.[2]?.type).toBe("context");
  return findFirstActionsBlock(payload) ?? { type: "actions", elements: [] };
}
function expectSingleDispatchedSlashBody(expectedBody) {
  expect(dispatchMock).toHaveBeenCalledTimes(1);
  const call = dispatchMock.mock.calls[0]?.[0];
  expect(call.ctx?.Body).toBe(expectedBody);
}
async function runCommandAndResolveActionsBlock(handler) {
  const { respond } = await runCommandHandler(handler);
  const payload = respond.mock.calls[0]?.[0];
  const blockId = payload.blocks?.find((block) => block.type === "actions")?.block_id;
  return { respond, payload, blockId };
}
async function getFirstActionElementFromCommand(handler) {
  const { respond } = await runCommandHandler(handler);
  expect(respond).toHaveBeenCalledTimes(1);
  const payload = respond.mock.calls[0]?.[0];
  const actions = findFirstActionsBlock(payload);
  return actions?.elements?.[0];
}
async function runArgMenuAction(handler, params) {
  const includeRespond = params.includeRespond ?? true;
  const respond = params.respond ?? vi.fn().mockResolvedValue(void 0);
  const payload = {
    ack: vi.fn().mockResolvedValue(void 0),
    action: params.action,
    body: {
      user: { id: params.userId ?? "U1", name: params.userName ?? "Ada" },
      channel: { id: params.channelId ?? "C1", name: params.channelName ?? "directmessage" },
      trigger_id: "t1"
    }
  };
  if (includeRespond) {
    payload.respond = respond;
  }
  await handler(payload);
  return respond;
}
describe("Slack native command argument menus", () => {
  let harness;
  let usageHandler;
  let reportHandler;
  let reportCompactHandler;
  let reportExternalHandler;
  let reportLongHandler;
  let unsafeConfirmHandler;
  let agentStatusHandler;
  let argMenuHandler;
  let argMenuOptionsHandler;
  beforeAll(async () => {
    harness = createArgMenusHarness();
    await registerCommands(harness.ctx, harness.account);
    usageHandler = requireHandler(harness.commands, "/usage", "/usage");
    reportHandler = requireHandler(harness.commands, "/report", "/report");
    reportCompactHandler = requireHandler(harness.commands, "/reportcompact", "/reportcompact");
    reportExternalHandler = requireHandler(harness.commands, "/reportexternal", "/reportexternal");
    reportLongHandler = requireHandler(harness.commands, "/reportlong", "/reportlong");
    unsafeConfirmHandler = requireHandler(harness.commands, "/unsafeconfirm", "/unsafeconfirm");
    agentStatusHandler = requireHandler(harness.commands, "/agentstatus", "/agentstatus");
    argMenuHandler = requireHandler(harness.actions, "openclaw_cmdarg", "arg-menu action");
    argMenuOptionsHandler = requireHandler(harness.options, "openclaw_cmdarg", "arg-menu options");
  });
  beforeEach(() => {
    harness.postEphemeral.mockClear();
  });
  it("registers options handlers without losing app receiver binding", async () => {
    const testHarness = createArgMenusHarness();
    await registerCommands(testHarness.ctx, testHarness.account);
    expect(testHarness.commands.size).toBeGreaterThan(0);
    expect(testHarness.actions.has("openclaw_cmdarg")).toBe(true);
    expect(testHarness.options.has("openclaw_cmdarg")).toBe(true);
    expect(testHarness.optionsReceiverContexts[0]).toBe(testHarness.app);
  });
  it("falls back to static menus when app.options() throws during registration", async () => {
    const commands = /* @__PURE__ */ new Map();
    const actions = /* @__PURE__ */ new Map();
    const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
    const app = {
      client: { chat: { postEphemeral } },
      command: (name, handler2) => {
        commands.set(name, handler2);
      },
      action: (id, handler2) => {
        actions.set(id, handler2);
      },
      // Simulate Bolt throwing during options registration (e.g. receiver not initialized)
      options: () => {
        throw new Error("Cannot read properties of undefined (reading 'listeners')");
      }
    };
    const ctx = {
      cfg: { commands: { native: true, nativeSkills: false } },
      runtime: {},
      botToken: "bot-token",
      botUserId: "bot",
      teamId: "T1",
      allowFrom: ["*"],
      dmEnabled: true,
      dmPolicy: "open",
      groupDmEnabled: false,
      groupDmChannels: [],
      defaultRequireMention: true,
      groupPolicy: "open",
      useAccessGroups: false,
      channelsConfig: void 0,
      slashCommand: {
        enabled: true,
        name: "openclaw",
        ephemeral: true,
        sessionPrefix: "slack:slash"
      },
      textLimit: 4e3,
      app,
      isChannelAllowed: () => true,
      resolveChannelName: async () => ({ name: "dm", type: "im" }),
      resolveUserName: async () => ({ name: "Ada" })
    };
    const account = {
      accountId: "acct",
      config: { commands: { native: true, nativeSkills: false } }
    };
    await registerCommands(ctx, account);
    expect(commands.size).toBeGreaterThan(0);
    expect(actions.has("openclaw_cmdarg")).toBe(true);
    const handler = commands.get("/reportexternal");
    expect(handler).toBeDefined();
    const respond = vi.fn().mockResolvedValue(void 0);
    const ack = vi.fn().mockResolvedValue(void 0);
    await handler({
      command: createSlashCommand(),
      ack,
      respond
    });
    expect(respond).toHaveBeenCalledTimes(1);
    const payload = respond.mock.calls[0]?.[0];
    const actionsBlock = findFirstActionsBlock(payload);
    expect(actionsBlock?.elements?.[0]?.type).toBe("static_select");
  });
  it("shows a button menu when required args are omitted", async () => {
    const { respond } = await runCommandHandler(usageHandler);
    const actions = expectArgMenuLayout(respond);
    const elementType = actions?.elements?.[0]?.type;
    expect(elementType).toBe("button");
    expect(actions?.elements?.[0]?.confirm).toBeTruthy();
  });
  it("shows a static_select menu when choices exceed button row size", async () => {
    const { respond } = await runCommandHandler(reportHandler);
    const actions = expectArgMenuLayout(respond);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("static_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element?.confirm).toBeTruthy();
  });
  it("falls back to buttons when static_select value limit would be exceeded", async () => {
    const firstElement = await getFirstActionElementFromCommand(reportLongHandler);
    expect(firstElement?.type).toBe("button");
    expect(firstElement?.confirm).toBeTruthy();
  });
  it("shows an overflow menu when choices fit compact range", async () => {
    const element = await getFirstActionElementFromCommand(reportCompactHandler);
    expect(element?.type).toBe("overflow");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element?.confirm).toBeTruthy();
  });
  it("escapes mrkdwn characters in confirm dialog text", async () => {
    const element = await getFirstActionElementFromCommand(unsafeConfirmHandler);
    expect(element?.confirm?.text?.text).toContain(
      "Run */unsafeconfirm* with *mode\\_\\*\\`\\~&lt;&amp;&gt;* set to this value?"
    );
  });
  it("dispatches the command when a menu button is clicked", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" })
      }
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0]?.[0];
    expect(call.ctx?.Body).toBe("/usage tokens");
  });
  it("maps /agentstatus to /status when dispatching", async () => {
    await runCommandHandler(agentStatusHandler);
    expectSingleDispatchedSlashBody("/status");
  });
  it("dispatches the command when a static_select option is chosen", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        selected_option: {
          value: encodeValue({ command: "report", arg: "period", value: "month", userId: "U1" })
        }
      }
    });
    expectSingleDispatchedSlashBody("/report month");
  });
  it("dispatches the command when an overflow option is chosen", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        selected_option: {
          value: encodeValue({
            command: "reportcompact",
            arg: "period",
            value: "quarter",
            userId: "U1"
          })
        }
      }
    });
    expectSingleDispatchedSlashBody("/reportcompact quarter");
  });
  it("shows an external_select menu when choices exceed static_select options max", async () => {
    const { respond, payload, blockId } = await runCommandAndResolveActionsBlock(reportExternalHandler);
    expect(respond).toHaveBeenCalledTimes(1);
    const actions = findFirstActionsBlock(payload);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("external_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(blockId).toContain("openclaw_cmdarg_ext:");
    const token = (blockId ?? "").slice("openclaw_cmdarg_ext:".length);
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
  it("serves filtered options for external_select menus", async () => {
    const { blockId } = await runCommandAndResolveActionsBlock(reportExternalHandler);
    expect(blockId).toContain("openclaw_cmdarg_ext:");
    const ackOptions = vi.fn().mockResolvedValue(void 0);
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        user: { id: "U1" },
        value: "period 12",
        actions: [{ block_id: blockId }]
      }
    });
    expect(ackOptions).toHaveBeenCalledTimes(1);
    const optionsPayload = ackOptions.mock.calls[0]?.[0];
    const optionTexts = (optionsPayload.options ?? []).map((option) => option.text?.text ?? "");
    expect(optionTexts.some((text) => text.includes("Period 12"))).toBe(true);
  });
  it("rejects external_select option requests without user identity", async () => {
    const { blockId } = await runCommandAndResolveActionsBlock(reportExternalHandler);
    expect(blockId).toContain("openclaw_cmdarg_ext:");
    const ackOptions = vi.fn().mockResolvedValue(void 0);
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        value: "period 1",
        actions: [{ block_id: blockId }]
      }
    });
    expect(ackOptions).toHaveBeenCalledTimes(1);
    expect(ackOptions).toHaveBeenCalledWith({ options: [] });
  });
  it("rejects menu clicks from other users", async () => {
    const respond = await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" })
      },
      userId: "U2",
      userName: "Eve"
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "That menu is for another user.",
      response_type: "ephemeral"
    });
  });
  it("falls back to postEphemeral with token when respond is unavailable", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: { value: "garbage" },
      includeRespond: false
    });
    expect(harness.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "bot-token",
        channel: "C1",
        user: "U1"
      })
    );
  });
  it("treats malformed percent-encoding as an invalid button (no throw)", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: { value: "cmdarg|%E0%A4%A|mode|on|U1" },
      includeRespond: false
    });
    expect(harness.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "bot-token",
        channel: "C1",
        user: "U1",
        text: "Sorry, that button is no longer valid."
      })
    );
  });
});
function createPolicyHarness(overrides) {
  const commands = /* @__PURE__ */ new Map();
  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const app = {
    client: { chat: { postEphemeral } },
    command: (name, handler) => {
      commands.set(name, handler);
    }
  };
  const channelId = overrides?.channelId ?? "C_UNLISTED";
  const channelName = overrides?.channelName ?? "unlisted";
  const ctx = {
    cfg: { commands: { native: false } },
    runtime: {},
    botToken: "bot-token",
    botUserId: "bot",
    teamId: "T1",
    allowFrom: overrides?.allowFrom ?? ["*"],
    dmEnabled: true,
    dmPolicy: "open",
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: overrides?.groupPolicy ?? "open",
    useAccessGroups: overrides?.useAccessGroups ?? true,
    channelsConfig: overrides?.channelsConfig,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash"
    },
    textLimit: 4e3,
    app,
    isChannelAllowed: () => true,
    shouldDropMismatchedSlackEvent: (body) => overrides?.shouldDropMismatchedSlackEvent?.(body) ?? false,
    resolveChannelName: overrides?.resolveChannelName ?? (async () => ({ name: channelName, type: "channel" })),
    resolveUserName: async () => ({ name: "Ada" })
  };
  const account = { accountId: "acct", config: { commands: { native: false } } };
  return { commands, ctx, account, postEphemeral, channelId, channelName };
}
async function runSlashHandler(params) {
  const handler = [...params.commands.values()][0];
  if (!handler) {
    throw new Error("Missing slash handler");
  }
  const respond = vi.fn().mockResolvedValue(void 0);
  const ack = vi.fn().mockResolvedValue(void 0);
  await handler({
    body: params.body,
    command: {
      user_id: "U1",
      user_name: "Ada",
      text: "hello",
      trigger_id: "t1",
      ...params.command
    },
    ack,
    respond
  });
  return { respond, ack };
}
async function registerAndRunPolicySlash(params) {
  await registerCommands(params.harness.ctx, params.harness.account);
  return await runSlashHandler({
    commands: params.harness.commands,
    body: params.body,
    command: {
      channel_id: params.command?.channel_id ?? params.harness.channelId,
      channel_name: params.command?.channel_name ?? params.harness.channelName,
      ...params.command
    }
  });
}
function expectChannelBlockedResponse(respond) {
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({
    text: "This channel is not allowed.",
    response_type: "ephemeral"
  });
}
function expectUnauthorizedResponse(respond) {
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({
    text: "You are not authorized to use this command.",
    response_type: "ephemeral"
  });
}
describe("slack slash commands channel policy", () => {
  it("drops mismatched slash payloads before dispatch", async () => {
    const harness = createPolicyHarness({
      shouldDropMismatchedSlackEvent: () => true
    });
    const { respond, ack } = await registerAndRunPolicySlash({
      harness,
      body: {
        api_app_id: "A_MISMATCH",
        team_id: "T_MISMATCH"
      }
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });
  it("allows unlisted channels when groupPolicy is open", async () => {
    const harness = createPolicyHarness({
      groupPolicy: "open",
      channelsConfig: { C_LISTED: { requireMention: true } },
      channelId: "C_UNLISTED",
      channelName: "unlisted"
    });
    const { respond } = await registerAndRunPolicySlash({ harness });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "This channel is not allowed." })
    );
  });
  it("blocks explicitly denied channels when groupPolicy is open", async () => {
    const harness = createPolicyHarness({
      groupPolicy: "open",
      channelsConfig: { C_DENIED: { allow: false } },
      channelId: "C_DENIED",
      channelName: "denied"
    });
    const { respond } = await registerAndRunPolicySlash({ harness });
    expectChannelBlockedResponse(respond);
  });
  it("blocks unlisted channels when groupPolicy is allowlist", async () => {
    const harness = createPolicyHarness({
      groupPolicy: "allowlist",
      channelsConfig: { C_LISTED: { requireMention: true } },
      channelId: "C_UNLISTED",
      channelName: "unlisted"
    });
    const { respond } = await registerAndRunPolicySlash({ harness });
    expectChannelBlockedResponse(respond);
  });
});
describe("slack slash commands access groups", () => {
  it("fails closed when channel type lookup returns empty for channels", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "C_UNKNOWN",
      channelName: "unknown",
      resolveChannelName: async () => ({})
    });
    const { respond } = await registerAndRunPolicySlash({ harness });
    expectUnauthorizedResponse(respond);
  });
  it("still treats D-prefixed channel ids as DMs when lookup fails", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "D123",
      channelName: "notdirectmessage",
      resolveChannelName: async () => ({})
    });
    const { respond } = await registerAndRunPolicySlash({
      harness,
      command: {
        channel_id: "D123",
        channel_name: "notdirectmessage"
      }
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "You are not authorized to use this command." })
    );
    const dispatchArg = dispatchMock.mock.calls[0]?.[0];
    expect(dispatchArg?.ctx?.CommandAuthorized).toBe(false);
  });
  it("computes CommandAuthorized for DM slash commands when dmPolicy is open", async () => {
    const harness = createPolicyHarness({
      allowFrom: ["U_OWNER"],
      channelId: "D999",
      channelName: "directmessage",
      resolveChannelName: async () => ({ name: "directmessage", type: "im" })
    });
    await registerAndRunPolicySlash({
      harness,
      command: {
        user_id: "U_ATTACKER",
        user_name: "Mallory",
        channel_id: "D999",
        channel_name: "directmessage"
      }
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchArg = dispatchMock.mock.calls[0]?.[0];
    expect(dispatchArg?.ctx?.CommandAuthorized).toBe(false);
  });
  it("enforces access-group gating when lookup fails for private channels", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "G123",
      channelName: "private",
      resolveChannelName: async () => ({})
    });
    const { respond } = await registerAndRunPolicySlash({ harness });
    expectUnauthorizedResponse(respond);
  });
});
describe("slack slash command session metadata", () => {
  const { recordSessionMetaFromInboundMock } = getSlackSlashMocks();
  it("calls recordSessionMetaFromInbound after dispatching a slash command", async () => {
    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerAndRunPolicySlash({ harness });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(recordSessionMetaFromInboundMock).toHaveBeenCalledTimes(1);
    const call = recordSessionMetaFromInboundMock.mock.calls[0]?.[0];
    expect(call.ctx?.OriginatingChannel).toBe("slack");
    expect(call.sessionKey).toBeDefined();
  });
  it("awaits session metadata persistence before dispatch", async () => {
    const deferred = createDeferred();
    recordSessionMetaFromInboundMock.mockClear().mockReturnValue(deferred.promise);
    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerCommands(harness.ctx, harness.account);
    const runPromise = runSlashHandler({
      commands: harness.commands,
      command: {
        channel_id: harness.channelId,
        channel_name: harness.channelName
      }
    });
    await vi.waitFor(() => {
      expect(recordSessionMetaFromInboundMock).toHaveBeenCalledTimes(1);
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    deferred.resolve();
    await runPromise;
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});
