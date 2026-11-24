import type { SlackShortcutMiddlewareArgs } from "@slack/bolt";
import type { resolvePluginConversationBindingApproval } from "openclaw/plugin-sdk/conversation-runtime";
import { vi } from "vitest";
import { encodeSlackApprovalAction, type SlackApprovalAction } from "../../approval-actions.js";
import { installSlackTestRuntime } from "../../test-runtime.test-support.js";
import type { SlackMonitorContext } from "../context.js";
import type { ParsedSlackBlockAction } from "./interactions.block-actions.context.js";

function buttonBlocks(blockId: string, control: { action_id: string; value?: string }) {
  return [{ type: "actions", block_id: blockId, elements: [{ type: "button", ...control }] }];
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

const execApprovals = (id: string) => ({ enabled: true, approvers: [id], target: "both" });

export function approvalContextOptions(pluginApprover: string, execApprover: string) {
  const account = { allowFrom: [pluginApprover], execApprovals: execApprovals(execApprover) };
  return { cfg: { channels: { slack: { accounts: { default: account } } } } };
}

export function approvedPluginBindingResult(): Extract<
  Awaited<ReturnType<typeof resolvePluginConversationBindingApproval>>,
  { status: "approved" }
> {
  const plugin = { pluginId: "codex", pluginRoot: "/plugins/codex" };
  const conversation = { channel: "slack", accountId: "default", conversationId: "C1" };
  return {
    status: "approved",
    decision: "allow-once",
    binding: {
      bindingId: "binding-123",
      ...plugin,
      ...conversation,
      boundAt: 0,
    },
    request: { id: "approval-123", ...plugin, conversation },
  };
}

type ListenerArgs<Body> = {
  ack: () => Promise<void>;
  client?: { chat: { update: (...args: unknown[]) => unknown } };
  context?: { teamId?: string; isEnterpriseInstall?: boolean; enterpriseId?: string };
  body: Body;
};

type Handler<Args> = (args: Args) => Promise<void>;
type ActionBody = Omit<ParsedSlackBlockAction["typedBody"], "user"> & {
  user: { id: string; team_id?: string };
};
type RegisteredHandler = Handler<
  ListenerArgs<ActionBody> & {
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

type RegisteredShortcutHandler = Handler<ListenerArgs<SlackShortcutMiddlewareArgs["body"]>>;

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
  isChannelAllowed?: OmitThisParameter<SlackMonitorContext["isChannelAllowed"]>;
  resolveUserName?: SlackMonitorContext["resolveUserName"];
  resolveChannelName?: SlackMonitorContext["resolveChannelName"];
};

function requireHandler<T>(handler: T | undefined, kind: string): T {
  if (!handler) {
    throw new Error(`Expected Slack ${kind} handler to be registered`);
  }
  return handler;
}

export function createContext({
  channelsConfig = {},
  cfg = { channels: { slack: { execApprovals: execApprovals("U123") } } },
  installationIdentity = { kind: "workspace", teamId: "T_TEST" },
  shouldDropMismatchedSlackEvent = () => false,
  ...policy
}: ContextOverrides = {}) {
  installSlackTestRuntime();
  const handlers: {
    action?: RegisteredHandler;
    view_submission?: RegisteredViewHandler;
    view_closed?: RegisteredViewHandler;
    shortcut?: RegisteredShortcutHandler;
  } = {};
  const listenerClient = {
    chat: { update: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined) },
  };
  const scoped =
    <Args extends ListenerArgs<unknown>>(next: Handler<Args>): Handler<Args> =>
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
        context: {
          ...context,
          ...(installationIdentity.kind === "enterprise"
            ? { isEnterpriseInstall: true, enterpriseId: installationIdentity.enterpriseId }
            : {}),
        },
        client: args.client ?? listenerClient,
      });
    };
  const app = {
    action: (_matcher: RegExp, next: RegisteredHandler) => {
      handlers.action = scoped(next);
    },
    view: (
      matcher: { callback_id: RegExp; type: "view_submission" | "view_closed" },
      next: RegisteredViewHandler,
    ) => {
      handlers[matcher.type] = scoped(next);
    },
    shortcut: (_matcher: RegExp, next: RegisteredShortcutHandler) => {
      handlers.shortcut = scoped(next);
    },
    client: listenerClient,
  };
  const runtimeLog = vi.fn<SlackMonitorContext["runtime"]["log"]>();
  const resolveSessionKey = vi
    .fn<SlackMonitorContext["resolveSlackSystemEventRoute"]>()
    .mockResolvedValue({
      agentId: "ops",
      sessionKey: "agent:ops:slack:channel:C1",
    });
  const ctx = {
    app,
    accountId: "default",
    installationIdentity,
    cfg,
    runtime: { log: runtimeLog },
    dmEnabled: policy.dmEnabled ?? true,
    dmPolicy: policy.dmPolicy ?? "open",
    allowFrom: policy.allowFrom ?? ["*"],
    allowNameMatching: policy.allowNameMatching ?? false,
    useAccessGroups: policy.useAccessGroups ?? true,
    channelsConfig,
    channelsConfigKeys: Object.keys(channelsConfig),
    defaultRequireMention: true,
    shouldDropMismatchedSlackEvent,
    isChannelAllowed: policy.isChannelAllowed ?? (() => true),
    resolveUserName: policy.resolveUserName ?? (async () => ({})),
    resolveChannelName: policy.resolveChannelName ?? (async () => ({})),
    resolveSlackSystemEventRoute: resolveSessionKey,
  };
  Object.assign(ctx, { readRuntimeContext: async () => ctx, isRuntimePolicyCurrent: () => true });
  return {
    ctx,
    app,
    runtimeLog,
    resolveSessionKey,
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
