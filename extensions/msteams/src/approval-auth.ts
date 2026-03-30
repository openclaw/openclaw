import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "../runtime-api.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";

const MSTEAMS_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeMSTeamsApproverId(value: string | number): string | undefined {
  const normalized = normalizeMSTeamsMessagingTarget(String(value));
  if (!normalized?.startsWith("user:")) {
    return undefined;
  }
  const id = normalized.slice("user:".length).trim().toLowerCase();
  return MSTEAMS_ID_RE.test(id) ? id : undefined;
}

function resolveMSTeamsChannelConfig(cfg: OpenClawConfig) {
  return cfg.channels?.msteams;
}

export const msTeamsApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Microsoft Teams",
  resolveApprovers: ({ cfg }) => {
    const channel = resolveMSTeamsChannelConfig(cfg);
    return resolveApprovalApprovers({
      allowFrom: channel?.allowFrom,
      defaultTo: channel?.defaultTo,
      normalizeApprover: normalizeMSTeamsApproverId,
    });
  },
  normalizeSenderId: (value) => {
    const trimmed = value.trim().toLowerCase();
    return MSTEAMS_ID_RE.test(trimmed) ? trimmed : undefined;
  },
});
