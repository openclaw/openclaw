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
  if (resolvePluginApprovalSlackApprovers(params.cfg, params.request) === undefined) {
    return isSlackApprovalAuthorizedSender(params);
  }
  const teamId = resolveSlackApprovalTeamId({ ...params, request: params.request });
  return Boolean(
    params.senderId &&
    slackApprovalTargetMatches(
      params.senderId,
      getSlackApprovalApproversForTeam({ ...params, teamId }),
      teamId,
    ),
  );
}

export function getSlackApprovalApproversForTeam(
  params: SlackApprovalContext & { teamId: string | undefined; request?: PluginApprovalRequest },
): string[] {
  const configured = params.request
    ? resolvePluginApprovalSlackApprovers(params.cfg, params.request)
    : undefined;
  if (params.request) {
    const accountId = resolveSlackAccount(params).accountId;
    const installedTeamId = getSlackInstallationTeamId(accountId);
    const originTeamId = resolveSlackApprovalOriginTeamId(params.request);
    const enterprise = getSlackInstallationKind(accountId) === "enterprise";
    // Routing and custody use the same workspace-filtered list. A configured
    // policy needs the bot's live identity, not merely a claimed request origin.
    if (
      (installedTeamId &&
        originTeamId &&
        installedTeamId.toLowerCase() !== originTeamId.toLowerCase()) ||
      (enterprise && !originTeamId) ||
      (configured !== undefined && !installedTeamId && !enterprise)
    ) {
      return [];
    }
  }
  const approvers = configured ?? getSlackApprovalApprovers(params);
  return resolveApprovalApprovers({
    allowFrom: resolveSlackUserAllowListForTeam({
      allowList: [...approvers],
      teamId: params.teamId,
    }),
    normalizeApprover: normalizeSlackApproverTarget,
  });
}

export function resolveSlackApprovalTeamId(
  params: SlackApprovalContext & {
    request: { request: { turnSourceChannel?: string | null; turnSourceTo?: string | null } };
  },
): string | undefined {
  return (
    getSlackInstallationTeamId(resolveSlackAccount(params).accountId) ??
    resolveSlackApprovalOriginTeamId(params.request)
  );
}
