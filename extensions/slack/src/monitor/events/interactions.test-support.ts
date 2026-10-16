import type { SlackShortcutMiddlewareArgs } from "@slack/bolt";
import { vi } from "vitest";
import { encodeSlackApprovalAction, type SlackApprovalAction } from "../../approval-actions.js";
import { installSlackTestRuntime } from "../../test-runtime.test-support.js";

export function singleButtonBlocks(blockId: string, actionId: string) {
  return [
    {
      type: "actions",
      block_id: blockId,
      elements: [{ type: "button", action_id: actionId }],
    },
  ];
}

export function approvalButtonBlocks(
  approvalId: string,
  approvalKind: SlackApprovalAction["approvalKind"],
  decision: SlackApprovalAction["decision"],
) {
  return [
    {
      type: "actions",
      block_id: "exec_actions",
      elements: [
        {
          type: "button",
          action_id: "openclaw:approval_button:1:1",
          value: encodeSlackApprovalAction({
            type: "approval",
            approvalId,
            approvalKind,
            decision,
          }),
        },
      ],
    },
  ];
}

export function approvalContextOptions(pluginApprover: string, execApprover: string) {
  return {
    cfg: {
      channels: {
        slack: {
          accounts: {
            default: {
              allowFrom: [pluginApprover],
              execApprovals: {
                enabled: true,
                approvers: [execApprover],
                target: "both",
              },
            },
          },
        },
      },
    },
  };
}

type RegisteredHandler = (args: {
  ack: () => Promise<void>;
  client?: TestSlackClient;
  context?: TestBoltContext;
  body: {
    user: { id: string; team_id?: string };
    team?: { id?: string };
    trigger_id?: string;
    response_url?: string;
    channel?: { id?: string };
    container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
    message?: { ts?: string; thread_ts?: string; text?: string; blocks?: unknown[] };
  };
  action: Record<string, unknown>;
  respond?: (payload: { text: string; response_type: string }) => Promise<void>;
}) => Promise<void>;

type RegisteredViewHandler = (args: {
  ack: () => Promise<void>;
  client?: TestSlackClient;
  context?: TestBoltContext;
  body: {
    user?: { id?: string; team_id?: string };
    team?: { id?: string };
    trigger_id?: string;
    view?: {
      id?: string;
      callback_id?: string;
      private_metadata?: string;
      root_view_id?: string;
      previous_view_id?: string;
      external_id?: string;
      hash?: string;
      app_installed_team_id?: string;
      state?: { values?: Record<string, Record<string, Record<string, unknown>>> };
    };
    is_cleared?: boolean;
  };
}) => Promise<void>;

type RegisteredShortcutHandler = (
  args: Pick<SlackShortcutMiddlewareArgs, "ack" | "body"> & {
    client?: TestSlackClient;
    context?: TestBoltContext;
  },
) => Promise<void>;

type TestBoltContext = {
  teamId?: string;
  isEnterpriseInstall?: boolean;
  enterpriseId?: string;
};

type TestSlackClient = {
  chat: { update: (...args: unknown[]) => unknown };
};

export function createContext(overrides?: {
  dmEnabled?: boolean;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom?: string[];
  allowNameMatching?: boolean;
  useAccessGroups?: boolean;
  channelsConfig?: Record<string, { users?: string[] }>;
  cfg?: Record<string, unknown>;
  installationIdentity?:
    | { kind: "workspace"; teamId: string }
    | { kind: "enterprise"; enterpriseId: string };
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
  isChannelAllowed?: (params: {
    channelId?: string;
    channelName?: string;
    channelType?: "im" | "mpim" | "channel" | "group";
  }) => boolean;
  resolveUserName?: (userId: string) => Promise<{ name?: string }>;
  resolveChannelName?: (channelId: string) => Promise<{
    name?: string;
    type?: "im" | "mpim" | "channel" | "group";
  }>;
}) {
  installSlackTestRuntime();
  let handler: RegisteredHandler | null = null;
  let viewHandler: RegisteredViewHandler | null = null;
  let viewClosedHandler: RegisteredViewHandler | null = null;
  let shortcutHandler: RegisteredShortcutHandler | null = null;
  const installationIdentity = overrides?.installationIdentity ?? {
    kind: "workspace" as const,
    teamId: "T_TEST",
  };
  const listenerClient = {
    chat: {
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
  const withBoltScope = <
    Args extends { body: unknown; context?: TestBoltContext; client?: TestSlackClient },
  >(
    args: Args,
  ): Args & { context: TestBoltContext; client: TestSlackClient } => {
    const body = args.body as {
      team?: { id?: string };
      user?: { team_id?: string };
      view?: { app_installed_team_id?: string };
    };
    const context = args.context ?? {
      teamId: body.view?.app_installed_team_id ?? body.team?.id ?? body.user?.team_id,
    };
    return {
      ...args,
      context:
        installationIdentity.kind === "enterprise"
          ? {
              ...context,
              isEnterpriseInstall: true,
              enterpriseId: installationIdentity.enterpriseId,
            }
          : context,
      client: args.client ?? listenerClient,
    };
  };
  const app = {
    action: vi.fn((_matcher: RegExp, next: RegisteredHandler) => {
      handler = async (args) => await next(withBoltScope(args));
    }),
    view: vi.fn(
      (
        matcher: { callback_id: RegExp; type: "view_submission" | "view_closed" },
        next: RegisteredViewHandler,
      ) => {
        if (matcher.type === "view_submission") {
          viewHandler = async (args) => await next(withBoltScope(args));
        } else {
          viewClosedHandler = async (args) => await next(withBoltScope(args));
        }
      },
    ),
    shortcut: vi.fn((_matcher: RegExp, next: RegisteredShortcutHandler) => {
      shortcutHandler = async (args) => await next(withBoltScope(args));
    }),
    client: listenerClient,
  };
  const runtimeLog = vi.fn();
  const resolveSessionKey = vi.fn().mockResolvedValue({
    agentId: "ops",
    sessionKey: "agent:ops:slack:channel:C1",
  });
  const isChannelAllowed = vi
    .fn<
      (params: {
        channelId?: string;
        channelName?: string;
        channelType?: "im" | "mpim" | "channel" | "group";
      }) => boolean
    >()
    .mockImplementation((params) => overrides?.isChannelAllowed?.(params) ?? true);
  const resolveUserName = vi
    .fn<(userId: string) => Promise<{ name?: string }>>()
    .mockImplementation((userId) => overrides?.resolveUserName?.(userId) ?? Promise.resolve({}));
  const resolveChannelName = vi
    .fn<
      (channelId: string) => Promise<{
        name?: string;
        type?: "im" | "mpim" | "channel" | "group";
      }>
    >()
    .mockImplementation(
      (channelId) => overrides?.resolveChannelName?.(channelId) ?? Promise.resolve({}),
    );
  const ctx = {
    app,
    accountId: "default",
    installationIdentity,
    cfg: overrides?.cfg ?? {
      channels: {
        slack: {
          execApprovals: {
            enabled: true,
            approvers: ["U123"],
            target: "both",
          },
        },
      },
    },
    runtime: { log: runtimeLog },
    dmEnabled: overrides?.dmEnabled ?? true,
    dmPolicy: overrides?.dmPolicy ?? ("open" as const),
    allowFrom: overrides?.allowFrom ?? ["*"],
    allowNameMatching: overrides?.allowNameMatching ?? false,
    useAccessGroups: overrides?.useAccessGroups ?? true,
    channelsConfig: overrides?.channelsConfig ?? {},
    channelsConfigKeys: Object.keys(overrides?.channelsConfig ?? {}),
    defaultRequireMention: true,
    shouldDropMismatchedSlackEvent: (body: unknown) =>
      overrides?.shouldDropMismatchedSlackEvent?.(body) ?? false,
    isChannelAllowed,
    resolveUserName,
    resolveChannelName,
    resolveSlackSystemEventRoute: resolveSessionKey,
  };
  Object.assign(ctx, { readRuntimeContext: async () => ctx, isRuntimePolicyCurrent: () => true });
  return {
    ctx,
    app,
    runtimeLog,
    resolveSessionKey,
    isChannelAllowed,
    resolveUserName,
    resolveChannelName,
    getHandler: () => {
      if (!handler) {
        throw new Error("Expected Slack action handler to be registered");
      }
      return handler;
    },
    getViewHandler: () => {
      if (!viewHandler) {
        throw new Error("Expected Slack view handler to be registered");
      }
      return viewHandler;
    },
    getViewClosedHandler: () => {
      if (!viewClosedHandler) {
        throw new Error("Expected Slack view-closed handler to be registered");
      }
      return viewClosedHandler;
    },
    getShortcutHandler: () => {
      if (!shortcutHandler) {
        throw new Error("Expected Slack shortcut handler to be registered");
      }
      return shortcutHandler;
    },
  };
}

export function createModalPickerStateValues() {
  return {
    env_block: {
      env_select: {
        type: "static_select",
        selected_option: {
          text: { type: "plain_text", text: "Production" },
          value: "prod",
        },
      },
    },
    assignee_block: {
      assignee_select: {
        type: "users_select",
        selected_user: "U900",
      },
    },
    channel_block: {
      channel_select: {
        type: "channels_select",
        selected_channel: "C900",
      },
    },
    convo_block: {
      convo_select: {
        type: "conversations_select",
        selected_conversation: "G900",
      },
    },
    date_block: {
      date_select: {
        type: "datepicker",
        selected_date: "2026-02-16",
      },
    },
    time_block: {
      time_select: {
        type: "timepicker",
        selected_time: "12:45",
      },
    },
    datetime_block: {
      datetime_select: {
        type: "datetimepicker",
        selected_date_time: 1_771_632_300,
      },
    },
    radio_block: {
      radio_select: {
        type: "radio_buttons",
        selected_option: {
          text: { type: "plain_text", text: "Blue" },
          value: "blue",
        },
      },
    },
    checks_block: {
      checks_select: {
        type: "checkboxes",
        selected_options: [
          { text: { type: "plain_text", text: "A" }, value: "a" },
          { text: { type: "plain_text", text: "B" }, value: "b" },
        ],
      },
    },
    number_block: {
      number_input: {
        type: "number_input",
        value: "42.5",
      },
    },
    email_block: {
      email_input: {
        type: "email_text_input",
        value: "team@openclaw.ai",
      },
    },
    url_block: {
      url_input: {
        type: "url_text_input",
        value: "https://docs.openclaw.ai",
      },
    },
    richtext_block: {
      richtext_input: {
        type: "rich_text_input",
        rich_text_value: {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "Ship this now" },
                { type: "text", text: "with canary metrics" },
              ],
            },
          ],
        },
      },
    },
  };
}

type ActionBody = Parameters<ReturnType<ReturnType<typeof createContext>["getHandler"]>>[0]["body"];
export function actionBody(
  message: Omit<NonNullable<ActionBody["message"]>, "ts">,
  {
    userId = "U123",
    channelId = "C1",
    ts = "100.200",
    threadTs,
    container = true,
    ...extra
  }: {
    userId?: string;
    channelId?: string;
    ts?: string;
    threadTs?: string;
    container?: boolean;
  } & Pick<ActionBody, "team" | "trigger_id" | "response_url"> = {},
): ActionBody {
  return {
    user: { id: userId },
    channel: { id: channelId },
    ...(container
      ? { container: { channel_id: channelId, message_ts: ts, thread_ts: threadTs } }
      : {}),
    message: { ts, ...message },
    ...extra,
  };
}

export const blockActionAuthorizationCases = [
  {
    name: "blocks channel block actions when sender is outside configured global allowFrom",
    overrides: { allowFrom: ["U_OWNER"] },
    senderId: "U_ATTACKER",
    channelId: "C1",
    timestamp: "250.251",
    allowed: false,
  },
  {
    name: "allows channel block actions when channel users allowlist authorizes the sender",
    overrides: {
      allowFrom: ["U_OWNER"],
      channelsConfig: { C1: { users: ["U_ALLOWED"] } },
    },
    senderId: "U_ALLOWED",
    channelId: "C1",
    timestamp: "260.261",
    allowed: true,
  },
  {
    name: "blocks wildcard global allowFrom from bypassing configured channel users",
    overrides: {
      allowFrom: ["*"],
      channelsConfig: { C1: { users: ["U_ALLOWED"] } },
    },
    senderId: "U_ATTACKER",
    channelId: "C1",
    timestamp: "270.271",
    allowed: false,
  },
  {
    name: "keeps channel block actions open when no allowlists are configured",
    overrides: { allowFrom: [] },
    senderId: "U_ANYONE",
    channelId: "C1",
    timestamp: "305.306",
    allowed: true,
  },
  {
    name: "blocks DM block actions when sender is not in allowFrom",
    overrides: { dmPolicy: "allowlist" as const, allowFrom: ["U_OWNER"] },
    senderId: "U_ATTACKER",
    channelId: "D222",
    timestamp: "301.302",
    allowed: false,
  },
  {
    name: "blocks MPIM block actions when sender is outside configured allowFrom",
    overrides: {
      allowFrom: ["U_OWNER"],
      resolveChannelName: async () => ({ name: "group-dm", type: "mpim" as const }),
    },
    senderId: "U_ATTACKER",
    channelId: "G_MPIM",
    timestamp: "311.312",
    allowed: false,
  },
  {
    name: "allows MPIM block actions when sender is in configured allowFrom",
    overrides: {
      allowFrom: ["U_OWNER"],
      resolveChannelName: async () => ({ name: "group-dm", type: "mpim" as const }),
    },
    senderId: "U_OWNER",
    channelId: "G_MPIM",
    timestamp: "313.314",
    allowed: true,
  },
];
