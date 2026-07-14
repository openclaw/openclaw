// Slack plugin module implements approval handler context resolution: the
// registered-context shape approval-handler.runtime.ts stores per account,
// and resolving both the account/context pair and the per-account Web API
// client to use for approval messages.
import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { ChannelApprovalCapabilityHandlerContext } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type SlackExecApprovalConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>["execApprovals"]
>;

export type SlackApprovalHandlerContext = {
  app: App;
  // Per-account Web API client bound to this account's own bot token. When
  // the Bolt App is shared across accounts (same app token installed in
  // multiple workspaces), app.client authenticates as whichever account
  // created the App — approval messages must go through this client instead.
  // Optional for contexts registered before this field existed; those fall
  // back to app.client via resolveSlackApprovalClient.
  client?: WebClient;
  config: SlackExecApprovalConfig;
};

export function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: SlackApprovalHandlerContext;
} | null {
  const context = params.context as SlackApprovalHandlerContext | undefined;
  const accountId = normalizeOptionalString(params.accountId) ?? "";
  if (!context?.app || !accountId) {
    return null;
  }
  return { accountId, context };
}

export function resolveSlackApprovalClient(context: SlackApprovalHandlerContext): WebClient {
  return context.client ?? context.app.client;
}
