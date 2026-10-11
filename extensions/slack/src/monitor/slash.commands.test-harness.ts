import type { ChatCommandDefinition } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  firstCallPayload,
  firstMockArg,
  getSlackSlashMocks,
  resetSlackSlashMocks,
} from "./slash.test-harness.js";

vi.mock("openclaw/plugin-sdk/agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/agent-runtime")>(
    "openclaw/plugin-sdk/agent-runtime",
  );
  return {
    ...actual,
    loadPreparedModelCatalog: vi.fn(async () => []),
  };
});

type StaticCommandChoice = string | { value: string; label: string };

const slashCommandFixtures = vi.hoisted(() => {
  const defineMenuCommand = (params: {
    name: string;
    choices: StaticCommandChoice[];
    argName?: string;
  }): ChatCommandDefinition => ({
    key: params.name,
    nativeName: params.name,
    description: `Slack ${params.name} test command`,
    textAliases: [],
    acceptsArgs: true,
    argsParsing: "positional",
    argsMenu: "auto",
    args: [
      {
        name: params.argName ?? "period",
        description: params.argName ?? "period",
        type: "string",
        choices: params.choices,
      },
    ],
    scope: "native",
  });
  const commands: ChatCommandDefinition[] = [
    {
      key: "login",
      nativeName: "login",
      description: "Login",
      textAliases: [],
      acceptsArgs: true,
      argsParsing: "none",
      scope: "native",
    },
    defineMenuCommand({
      name: "reportlong",
      choices: ["day", "week", "month", "quarter", "year", "x".repeat(100)],
    }),
    defineMenuCommand({
      name: "reportlongbutton",
      choices: [{ value: "x".repeat(170), label: "Long button label ".repeat(8) }],
    }),
    defineMenuCommand({
      name: "reporthugebutton",
      choices: Array.from({ length: 250 }, (_value, index) => ({
        value: `${String(index + 1)}-${"x".repeat(170)}`,
        label: `Long button label ${index + 1}`,
      })),
    }),
    defineMenuCommand({
      name: "reporthugevalue",
      choices: [
        { value: "valid", label: "Valid" },
        { value: "x".repeat(2500), label: "Overlong" },
      ],
    }),
    defineMenuCommand({
      name: "reportexternal",
      choices: [
        ...Array.from({ length: 140 }, (_value, index) => ({
          value: `period-${index + 1}`,
          label: `Period ${index + 1}`,
        })),
        // The emoji straddles Slack's 75-character plain-text limit.
        { value: "emoji-overflow", label: `${"a".repeat(74)}😀 emojioverflow` },
      ],
    }),
    defineMenuCommand({
      name: "unsafeconfirm",
      argName: "mode_*`~<&>",
      choices: ["on", "off"],
    }),
    defineMenuCommand({
      name: "longconfirm",
      argName: `mode_${"x".repeat(320)}`,
      choices: ["on", "off"],
    }),
  ];
  const specs = commands.map((command): NativeCommandSpec => ({
    name: command.nativeName!,
    description: command.description,
    acceptsArgs: true,
    args: command.args,
  }));
  return {
    commandsByName: new Map(commands.map((command) => [command.nativeName!, command])),
    specs: [
      ...specs,
      { name: "agentstatus", description: "Status", acceptsArgs: false },
    ] satisfies NativeCommandSpec[],
  };
});

const pluginCommandFixtures = vi.hoisted(() => ({
  specs: [] as Array<
    NativeCommandSpec & {
      channels?: string[];
      execute?: (args?: string) => Promise<{ text: string }>;
    }
  >,
}));

const skillCommandFixtures = vi.hoisted(() => ({
  commands: [] as Array<{ name: string; skillName: string; description: string }>,
}));

export function getSlackCommandFixtures() {
  return { pluginCommandFixtures, skillCommandFixtures };
}

vi.mock("openclaw/plugin-sdk/command-auth-native", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/command-auth-native")>(
    "openclaw/plugin-sdk/command-auth-native",
  );
  return {
    ...actual,
    findCommandByNativeName: (
      ...args: Parameters<typeof actual.findCommandByNativeName>
    ): ReturnType<typeof actual.findCommandByNativeName> =>
      slashCommandFixtures.commandsByName.get(args[0]) ??
      (args[0] === "agentstatus"
        ? actual.findCommandByNativeName("status", undefined, args[2])
        : undefined) ??
      // Plugin discovery can recursively load Slack while this test is importing
      // its monitor. The built-in command definitions are the behavior under test.
      actual.findCommandByNativeName(args[0], undefined, args[2]),
    listNativeCommandSpecsForConfig: (
      ...args: Parameters<typeof actual.listNativeCommandSpecsForConfig>
    ): ReturnType<typeof actual.listNativeCommandSpecsForConfig> => [
      ...actual.listNativeCommandSpecsForConfig(args[0], {
        ...args[1],
        provider: undefined,
      }),
      ...slashCommandFixtures.specs,
    ],
    listSkillCommandsForAgents: () => skillCommandFixtures.commands,
  };
});

type RegisterFn = (params: {
  ctx: unknown;
  account: unknown;
}) => Promise<{ mode: "single"; name: string } | { mode: "native" } | { mode: "disabled" }>;
const { registerSlackMonitorSlashCommands } = (await import("./slash.js")) as {
  registerSlackMonitorSlashCommands: RegisterFn;
};

const { dispatchMock } = getSlackSlashMocks();
setActivePluginRegistry(createEmptyPluginRegistry());

beforeEach(() => {
  pluginCommandFixtures.specs = [];
  skillCommandFixtures.commands = [];
  clearRuntimeConfigSnapshot();
  resetSlackSlashMocks();
  clearPluginCommands();
});

afterEach(() => {
  pluginCommandFixtures.specs = [];
  skillCommandFixtures.commands = [];
  clearRuntimeConfigSnapshot();
  clearPluginCommands();
});

export async function registerCommands(ctx: unknown, account: unknown, trackEvent?: () => void) {
  const registry = getActivePluginRegistry();
  for (const spec of pluginCommandFixtures.specs) {
    if (registry?.commands.some((entry) => entry.command.name === spec.name)) {
      continue;
    }
    expect(
      registerPluginCommand(`test-${spec.name}`, {
        name: spec.name,
        description: spec.description,
        acceptsArgs: spec.acceptsArgs,
        channels: spec.channels,
        handler: async ({ args }) => (spec.execute ? await spec.execute(args) : { text: "plugin" }),
      }),
    ).toEqual({ ok: true });
  }
  return await registerSlackMonitorSlashCommands({
    ctx: ctx as never,
    account: account as never,
    trackEvent,
  } as never);
}

export function encodeValue(parts: {
  command: string;
  arg: string;
  value: string;
  userId: string;
}) {
  return [
    "cmdarg",
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId),
  ].join("|");
}

export function createArgMenusHarness(
  cfg: OpenClawConfig = { commands: { native: true, nativeSkills: false } },
  scope?: {
    installationIdentity?:
      | { kind: "workspace"; teamId: string }
      | { kind: "enterprise"; enterpriseId: string };
    teamId?: string;
  },
) {
  const commands = new Map<string | RegExp, (args: unknown) => Promise<void>>();
  const commandRegistrations: Array<string | RegExp> = [];
  const actions = new Map<string | RegExp, (args: unknown) => Promise<void>>();
  const options = new Map<string, (args: unknown) => Promise<void>>();
  const optionsReceiverContexts: unknown[] = [];

  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const listenerClient = { chat: { postEphemeral } };
  const installationIdentity = scope?.installationIdentity ?? {
    kind: "workspace" as const,
    teamId: scope?.teamId ?? "T1",
  };
  const boltContext =
    installationIdentity.kind === "enterprise"
      ? {
          teamId: scope?.teamId,
          enterpriseId: installationIdentity.enterpriseId,
          isEnterpriseInstall: true,
        }
      : { teamId: installationIdentity.teamId, isEnterpriseInstall: false };
  const withBoltScope = (args: unknown) => {
    const typed = args as { context?: Record<string, unknown>; client?: unknown };
    return {
      ...typed,
      context: { ...boltContext, ...typed.context },
      client: typed.client ?? listenerClient,
    };
  };
  const app = {
    client: listenerClient,
    command: (name: string | RegExp, handler: (args: unknown) => Promise<void>) => {
      commandRegistrations.push(name);
      commands.set(name, async (args) => await handler(withBoltScope(args)));
    },
    action: (id: string | RegExp, handler: (args: unknown) => Promise<void>) => {
      actions.set(id, async (args) => await handler(withBoltScope(args)));
    },
    options(this: unknown, id: string, handler: (args: unknown) => Promise<void>) {
      optionsReceiverContexts.push(this);
      options.set(id, async (args) => await handler(withBoltScope(args)));
    },
  };

  const ctx = {
    cfg,
    runtime: {},
    botToken: "bot-token",
    botUserId: "bot",
    teamId: installationIdentity.kind === "enterprise" ? "" : installationIdentity.teamId,
    installationIdentity,
    allowFrom: ["*"],
    dmEnabled: true,
    dmPolicy: "open",
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: "open",
    useAccessGroups: false,
    channelsConfig: undefined,
    slashCommand: {
      enabled: false,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    app,
    isChannelAllowed: () => true,
    resolveChannelName: async () => ({ name: "dm", type: "im" }),
    resolveUserName: async () => ({ name: "Ada" }),
  };

  Object.assign(ctx, { readRuntimeContext: async () => ctx, isRuntimePolicyCurrent: () => true });
  const account = {
    accountId: "acct",
    config: { commands: { native: true, nativeSkills: false } },
  } as unknown;

  return {
    commandRegistrations,
    commands,
    actions,
    options,
    optionsReceiverContexts,
    postEphemeral,
    ctx,
    account,
    app,
  };
}

export function requireHandler(
  handlers: Map<string | RegExp, (args: unknown) => Promise<void>>,
  key: string | RegExp,
  label: string,
): (args: unknown) => Promise<void> {
  const handler =
    key instanceof RegExp
      ? Array.from(handlers.entries()).find(
          ([candidate]) => candidate instanceof RegExp && String(candidate) === String(key),
        )?.[1]
      : handlers.get(key);
  if (!handler) {
    throw new Error(`Missing ${label} handler`);
  }
  return handler;
}

export function createSlashCommand(overrides: Partial<Record<string, string>> = {}) {
  return {
    user_id: "U1",
    user_name: "Ada",
    channel_id: "C1",
    channel_name: "directmessage",
    text: "",
    trigger_id: "t1",
    ...overrides,
  };
}

export async function runCommandHandler(
  handler: (args: unknown) => Promise<void>,
  commandOverrides: Partial<Record<string, string>> = {},
) {
  const respond = vi.fn().mockResolvedValue(undefined);
  const ack = vi.fn().mockResolvedValue(undefined);
  await handler({
    command: createSlashCommand(commandOverrides),
    ack,
    respond,
  });
  return { respond, ack };
}

export async function runArgMenuAction(
  handler: (args: unknown) => Promise<void>,
  params: {
    action: Record<string, unknown>;
    userId?: string;
    userName?: string;
    channelId?: string;
    channelName?: string;
    message?: { ts: string; thread_ts?: string };
    container?: { message_ts: string; thread_ts?: string };
    respond?: ReturnType<typeof vi.fn>;
    includeRespond?: boolean;
  },
) {
  const includeRespond = params.includeRespond ?? true;
  const respond = params.respond ?? vi.fn().mockResolvedValue(undefined);
  const payload: Record<string, unknown> = {
    ack: vi.fn().mockResolvedValue(undefined),
    action: params.action,
    body: {
      user: { id: params.userId ?? "U1", name: params.userName ?? "Ada" },
      channel: { id: params.channelId ?? "C1", name: params.channelName ?? "directmessage" },
      trigger_id: "t1",
      ...(params.message ? { message: params.message } : {}),
      ...(params.container ? { container: params.container } : {}),
    },
  };
  if (includeRespond) {
    payload.respond = respond;
  }
  await handler(payload);
  return respond;
}

export function firstDispatchArg(): { ctx?: Record<string, unknown> } {
  return firstMockArg(dispatchMock, 0, "dispatch") as {
    ctx?: Record<string, unknown>;
  };
}

export function findFirstActionsBlock(payload: { blocks?: Array<{ type: string }> }) {
  return payload.blocks?.find((block) => block.type === "actions") as
    | { type: string; elements?: Array<{ type?: string; action_id?: string; confirm?: unknown }> }
    | undefined;
}

export function setAsyncDispatchMock(
  implementation: (params: { replyOptions?: Record<PropertyKey, unknown> }) => Promise<unknown>,
) {
  (
    dispatchMock as unknown as {
      mockImplementation: (callback: typeof implementation) => unknown;
    }
  ).mockImplementation(implementation);
}

export function expectArgMenuLayout(respond: ReturnType<typeof vi.fn>): {
  type: string;
  elements?: Array<{ type?: string; action_id?: string; confirm?: unknown }>;
} {
  expect(respond).toHaveBeenCalledTimes(1);
  const payload = firstCallPayload(respond, "response") as { blocks?: Array<{ type: string }> };
  expect(payload.blocks?.[0]?.type).toBe("header");
  expect(payload.blocks?.[1]?.type).toBe("section");
  expect(payload.blocks?.[2]?.type).toBe("context");
  const actions = findFirstActionsBlock(payload);
  if (!actions) {
    throw new Error("actions block missing");
  }
  return actions;
}

export function expectSingleDispatchedSlashBody(expectedBody: string) {
  expect(dispatchMock).toHaveBeenCalledTimes(1);
  const call = firstDispatchArg() as { ctx?: { Body?: string } };
  expect(call.ctx?.Body).toBe(expectedBody);
}

type ActionsBlockPayload = {
  blocks?: Array<{ type: string; block_id?: string }>;
};

export async function runCommandAndResolveActionsBlock(
  handler: (args: unknown) => Promise<void>,
): Promise<{
  respond: ReturnType<typeof vi.fn>;
  payload: ActionsBlockPayload;
  blockId?: string;
}> {
  const { respond } = await runCommandHandler(handler);
  const payload = firstCallPayload(respond, "response") as ActionsBlockPayload;
  const blockId = payload.blocks?.find((block) => block.type === "actions")?.block_id;
  return { respond, payload, blockId };
}

export async function getFirstActionElementFromCommand(handler: (args: unknown) => Promise<void>) {
  const { respond } = await runCommandHandler(handler);
  expect(respond).toHaveBeenCalledTimes(1);
  const payload = firstCallPayload(respond, "response") as { blocks?: Array<{ type: string }> };
  const actions = findFirstActionsBlock(payload);
  const element = actions?.elements?.[0];
  if (!element) {
    throw new Error("first action element missing");
  }
  return element;
}

export async function getCommandArgMenuValues(handler: (args: unknown) => Promise<void>) {
  const { respond } = await runCommandHandler(handler);
  const payload = firstCallPayload(respond, "response") as {
    blocks?: Array<{
      type: string;
      elements?: Array<{ value?: string; options?: Array<{ value?: string }> }>;
    }>;
  };
  const encodedValues = (payload.blocks ?? [])
    .filter((block) => block.type === "actions")
    .flatMap((block) =>
      (block.elements ?? []).flatMap((element) => {
        const values = (element.options ?? []).flatMap((option) =>
          option.value ? [option.value] : [],
        );
        if (element.value) {
          values.unshift(element.value);
        }
        return values;
      }),
    );
  return encodedValues.flatMap((value) => {
    const encodedChoice = value.split("|")[3];
    return encodedChoice ? [decodeURIComponent(encodedChoice)] : [];
  });
}

export function mockSixDispatchedReplies() {
  const { deliverSlackSlashRepliesMock } = getSlackSlashMocks();
  deliverSlackSlashRepliesMock.mockImplementation(async (params: unknown) => {
    const { replies, responseBudget } = params as {
      replies: Array<{ text: string }>;
      responseBudget: { respond: (payload: { text: string }) => Promise<unknown> };
    };
    for (const reply of replies) {
      await responseBudget.respond({ text: reply.text });
    }
  });
  dispatchMock.mockImplementation((params: unknown) => {
    const deliver = (
      params as {
        dispatcherOptions: {
          deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
        };
      }
    ).dispatcherOptions.deliver;
    for (let index = 0; index < 6; index += 1) {
      void deliver({ text: `reply ${String(index + 1)}` }, { kind: "final" });
    }
    return { counts: { final: 6, tool: 0, block: 0 } };
  });
}
