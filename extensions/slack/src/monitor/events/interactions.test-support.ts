import type { SlackShortcutMiddlewareArgs } from "@slack/bolt";
import { vi } from "vitest";
import { encodeSlackApprovalAction, type SlackApprovalAction } from "../../approval-actions.js";
import { installSlackTestRuntime } from "../../test-runtime.test-support.js";
import type { SlackMonitorContext } from "../context.js";

function buttonBlocks(blockId: string, control: { action_id: string; value?: string }) {
  return [
    {
      type: "actions",
      block_id: blockId,
      elements: [{ type: "button", ...control }],
    },
  ];
}

export function singleButtonBlocks(blockId: string, actionId: string) {
  return buttonBlocks(blockId, { action_id: actionId });
}

export function approvalButtonBlocks(
  approvalId: string,
  approvalKind: SlackApprovalAction["approvalKind"],
  decision: SlackApprovalAction["decision"],
) {
  return buttonBlocks("exec_actions", {
    action_id: "openclaw:approval_button:1:1",
    value: encodeSlackApprovalAction({ type: "approval", approvalId, approvalKind, decision }),
  });
}

const execApprovals = (approver: string) => ({
  enabled: true,
  approvers: [approver],
  target: "both",
});

export function approvalContextOptions(pluginApprover: string, execApprover: string) {
  const account = { allowFrom: [pluginApprover], execApprovals: execApprovals(execApprover) };
  return { cfg: { channels: { slack: { accounts: { default: account } } } } };
}

export function approvedPluginBindingResult(): Extract<
  Awaited<
    ReturnType<
      typeof import("openclaw/plugin-sdk/conversation-runtime").resolvePluginConversationBindingApproval
    >
  >,
  { status: "approved" }
> {
  return {
    status: "approved",
    decision: "allow-once",
    binding: {
      bindingId: "binding-123",
      pluginId: "codex",
      pluginRoot: "/plugins/codex",
      channel: "slack",
      accountId: "default",
      conversationId: "C1",
      boundAt: 0,
    },
    request: {
      id: "approval-123",
      pluginId: "codex",
      pluginName: "Codex",
      pluginRoot: "/plugins/codex",
      summary: "for this thread",
      conversation: { channel: "slack", accountId: "default", conversationId: "C1" },
    },
  };
}

type ListenerArgs<Body> = {
  ack: () => Promise<void>;
  client?: TestSlackClient;
  context?: TestBoltContext;
  body: Body;
};

type Handler<Args> = (args: Args) => Promise<void>;
type RegisteredHandler = Handler<
  ListenerArgs<{
    user: { id: string; team_id?: string };
    team?: { id?: string };
    trigger_id?: string;
    response_url?: string;
    channel?: { id?: string };
    container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
    message?: { ts?: string; thread_ts?: string; text?: string; blocks?: unknown[] };
  }> & {
    action: Record<string, unknown>;
    respond?: (payload: { text: string; response_type: string }) => Promise<void>;
  }
>;

type RegisteredViewHandler = Handler<
  ListenerArgs<{
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
  }>
>;

type RegisteredShortcutHandler = Handler<
  Pick<SlackShortcutMiddlewareArgs, "ack" | "body"> & {
    client?: TestSlackClient;
    context?: TestBoltContext;
  }
>;

type TestBoltContext = {
  teamId?: string;
  isEnterpriseInstall?: boolean;
  enterpriseId?: string;
};

type TestSlackClient = {
  chat: { update: (...args: unknown[]) => unknown };
};

type ContextOverrides = {
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
};

function requireHandler<T>(handler: T | undefined, kind: string): T {
  if (!handler) {
    throw new Error(`Expected Slack ${kind} handler to be registered`);
  }
  return handler;
}

export function createContext({
  dmEnabled = true,
  dmPolicy = "open",
  allowFrom = ["*"],
  allowNameMatching = false,
  useAccessGroups = true,
  channelsConfig = {},
  cfg = { channels: { slack: { execApprovals: execApprovals("U123") } } },
  installationIdentity = { kind: "workspace", teamId: "T_TEST" },
  shouldDropMismatchedSlackEvent = () => false,
  isChannelAllowed: channelAllowed = () => true,
  resolveUserName: userName = async () => ({}),
  resolveChannelName: channelName = async () => ({}),
}: ContextOverrides = {}) {
  installSlackTestRuntime();
  const handlers: {
    action?: RegisteredHandler;
    view_submission?: RegisteredViewHandler;
    view_closed?: RegisteredViewHandler;
    shortcut?: RegisteredShortcutHandler;
  } = {};
  const listenerClient = {
    chat: {
      update: vi.fn<TestSlackClient["chat"]["update"]>().mockResolvedValue(undefined),
    },
  };
  const scoped =
    <Args extends { body: unknown; context?: TestBoltContext; client?: TestSlackClient }>(
      next: Handler<Args>,
    ): Handler<Args> =>
    async (args) => {
      const body = args.body as {
        team?: { id?: string };
        user?: { team_id?: string };
        view?: { app_installed_team_id?: string };
      };
      const context = args.context ?? {
        teamId: body.view?.app_installed_team_id ?? body.team?.id ?? body.user?.team_id,
      };
      return next({
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
      });
    };
  const app = {
    action: vi.fn((_matcher: RegExp, next: RegisteredHandler) => {
      handlers.action = scoped(next);
    }),
    view: vi.fn(
      (
        matcher: { callback_id: RegExp; type: "view_submission" | "view_closed" },
        next: RegisteredViewHandler,
      ) => {
        handlers[matcher.type] = scoped(next);
      },
    ),
    shortcut: vi.fn((_matcher: RegExp, next: RegisteredShortcutHandler) => {
      handlers.shortcut = scoped(next);
    }),
    client: listenerClient,
  };
  const runtimeLog = vi.fn<SlackMonitorContext["runtime"]["log"]>();
  const resolveSessionKey = vi
    .fn<SlackMonitorContext["resolveSlackSystemEventRoute"]>()
    .mockResolvedValue({
      agentId: "ops",
      sessionKey: "agent:ops:slack:channel:C1",
    });
  const isChannelAllowed = vi.fn(channelAllowed);
  const resolveUserName = vi.fn(userName);
  const resolveChannelName = vi.fn(channelName);
  const ctx = {
    app,
    accountId: "default",
    installationIdentity,
    cfg,
    runtime: { log: runtimeLog },
    dmEnabled,
    dmPolicy,
    allowFrom,
    allowNameMatching,
    useAccessGroups,
    channelsConfig,
    channelsConfigKeys: Object.keys(channelsConfig),
    defaultRequireMention: true,
    shouldDropMismatchedSlackEvent,
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
    getHandler: () => requireHandler(handlers.action, "action"),
    getViewHandler: () => requireHandler(handlers.view_submission, "view"),
    getViewClosedHandler: () => requireHandler(handlers.view_closed, "view-closed"),
    getShortcutHandler: () => requireHandler(handlers.shortcut, "shortcut"),
  };
}

export function plainText(text: string) {
  return { type: "plain_text", text };
}
export function button(actionId: string, blockId: string, value: string, label: string) {
  return { type: "button", action_id: actionId, block_id: blockId, value, text: plainText(label) };
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
