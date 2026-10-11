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
  const resolveSessionKey = vi.fn().mockReturnValue({
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
