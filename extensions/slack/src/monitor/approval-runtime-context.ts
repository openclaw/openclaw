import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import {
  getChannelRuntimeContext,
  registerChannelRuntimeContext,
} from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig, SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SlackInstallationIdentity } from "./enterprise-install.js";

export function registerSlackApprovalRuntimeContext(params: {
  app: App;
  config: NonNullable<SlackAccountConfig["execApprovals"]>;
  readConfig: () => OpenClawConfig;
  resolveClient: (teamId?: string) => WebClient;
  identity: Extract<SlackInstallationIdentity, { kind: "workspace" | "enterprise" }>;
  channelRuntime?: ChannelRuntimeSurface;
  accountId: string;
  abortSignal?: AbortSignal;
}): void {
  const approvalContext = {
    app: params.app,
    config: params.config,
    readConfig: params.readConfig,
    resolveClient: params.resolveClient,
    assertCurrent: () => {
      // A queued approval send must still belong to this registered monitor.
      if (
        params.abortSignal?.aborted ||
        getChannelRuntimeContext({
          channelRuntime: params.channelRuntime,
          channelId: "slack",
          accountId: params.accountId,
          capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        }) !== approvalContext
      ) {
        throw new Error("Slack approval delivery is no longer authorized");
      }
    },
    ...(params.identity.kind === "workspace" ? { workspaceTeamId: params.identity.teamId } : {}),
    ...(params.identity.kind === "enterprise"
      ? { enterprise: { enterpriseId: params.identity.enterpriseId } }
      : {}),
  };
  registerChannelRuntimeContext({
    channelRuntime: params.channelRuntime,
    channelId: "slack",
    accountId: params.accountId,
    capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
    context: approvalContext,
    abortSignal: params.abortSignal,
  });
}
