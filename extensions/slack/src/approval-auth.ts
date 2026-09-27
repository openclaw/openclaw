import {
  createChannelApprovalAuth,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeStringEntriesLower } from "openclaw/plugin-sdk/string-normalization-runtime";
import { resolveSlackAccount, resolveSlackAccountAllowFrom } from "./accounts.js";
import { resolvePluginApprovalSlackApprovers } from "./approval-plugin-policy.js";
import { normalizeSlackApproverTarget } from "./exec-approvals.js";
import {
  getSlackInstallationKind,
  getSlackInstallationTeamId,
} from "./installation-identity-state.js";
import {
  resolveSlackAllowListMatch,
  resolveSlackUserAllowListForTeam,
} from "./monitor/allow-list.js";
import { parseSlackTarget } from "./target-parsing.js";

type SlackApprovalContext = Parameters<typeof resolveSlackAccount>[0];

function resolveSlackApprovalInputs(params: SlackApprovalContext) {
  const account = resolveSlackAccount(params).config;
  return {
    allowFrom: resolveSlackAccountAllowFrom(params),
    defaultTo: account.defaultTo,
  };
}

function slackApprovalTargetMatches(
  senderId: string,
  approvers: readonly string[],
  accountTeamId?: string,
): boolean {
  const sender = parseSlackTarget(senderId, { defaultKind: "user" });
  return (
    sender?.kind === "user" &&
    (!accountTeamId || sender.teamId?.toLowerCase() === accountTeamId.toLowerCase()) &&
    resolveSlackAllowListMatch({
      allowList: normalizeStringEntriesLower([...approvers]),
      teamId: sender.teamId,
      id: sender.id,
    }).allowed
  );
}

export function resolveSlackApprovalOriginTeamId(request: {
  request: { turnSourceChannel?: string | null; turnSourceTo?: string | null };
}): string | undefined {
  if (normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel) !== "slack") {
    return undefined;
  }
  try {
    return parseSlackTarget(request.request.turnSourceTo ?? "")?.teamId;
  } catch {
    return undefined;
  }
}

const slackApproval = createChannelApprovalAuth({
  channelLabel: "Slack",
  resolveInputs: resolveSlackApprovalInputs,
  normalizeApprover: normalizeSlackApproverTarget,
  normalizeDefaultTo: normalizeSlackApproverTarget,
  normalizeSenderId: normalizeSlackApproverTarget,
  isWildcardAuthorized: ({ purpose, senderId, inputs, approvers }) =>
    Boolean(
      senderId &&
      (slackApprovalTargetMatches(senderId, approvers) ||
        (purpose === "sender" &&
          approvers.length === 0 &&
          inputs.allowFrom?.some((entry) => String(entry).trim() === "*"))),
    ),
});

export const getSlackApprovalApprovers = slackApproval.resolveApprovers;
const isSlackApprovalAuthorizedSender = slackApproval.isAuthorizedSender;

export function hasConfiguredSlackPluginApprovalApprovers(params: SlackApprovalContext): boolean {
  const policy = params.cfg.approvals?.plugin?.slack;
  return (
    (policy?.approvers?.length ?? 0) > 0 ||
    Object.values(policy?.plugins ?? {}).some(
      (plugin) =>
        (plugin.approvers?.length ?? 0) > 0 ||
        Object.values(plugin.tools ?? {}).some((tool) => tool.approvers.length > 0),
    )
  );
}

export function isSlackPluginApprovalAuthorizedSender(
  params: SlackApprovalContext & {
    senderId?: string | null;
    request?: PluginApprovalRequest;
  },
): boolean {
  if (!params.request) {
    // /approve and callbacks cannot inspect the pending request locally. Let
    // a validated sender reach Gateway custody, which checks the exact request.
    return params.cfg.approvals?.plugin?.slack
      ? Boolean(params.senderId && normalizeSlackApproverTarget(params.senderId))
      : isSlackApprovalAuthorizedSender(params);
  }
  const configured = resolvePluginApprovalSlackApprovers(params.cfg, params.request);
  const accountId = resolveSlackAccount(params).accountId;
  const installedTeamId = getSlackInstallationTeamId(accountId);
  const originTeamId = resolveSlackApprovalOriginTeamId(params.request);
  const installationKind = getSlackInstallationKind(accountId);
  // A scoped decision needs a live bot identity; the request's origin alone
  // cannot authorize a queued click after that installation stops.
  if (
    (installedTeamId &&
      originTeamId &&
      installedTeamId.toLowerCase() !== originTeamId.toLowerCase()) ||
    (installationKind === "enterprise" && !originTeamId) ||
    (configured !== undefined && !installedTeamId && installationKind !== "enterprise")
  ) {
    return false;
  }
  return configured === undefined
    ? isSlackApprovalAuthorizedSender(params)
    : Boolean(
        params.senderId &&
        // Custody must count only reviewers in the bot's authenticated workspace.
        slackApprovalTargetMatches(params.senderId, configured, installedTeamId ?? originTeamId),
      );
}

export function getSlackApprovalApproversForTeam(
  params: SlackApprovalContext & { teamId: string | undefined; request?: PluginApprovalRequest },
): string[] {
  // Potential routing retains qualified selectors, but concrete delivery must
  // bind them to the validated request workspace before it creates any DM.
  const approvers = params.request
    ? (resolvePluginApprovalSlackApprovers(params.cfg, params.request) ??
      getSlackApprovalApprovers(params))
    : getSlackApprovalApprovers(params);
  return resolveApprovalApprovers({
    allowFrom: resolveSlackUserAllowListForTeam({
      allowList: [...approvers],
      teamId: params.teamId,
    }),
    normalizeApprover: normalizeSlackApproverTarget,
  });
}
