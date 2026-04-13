import type { OpenClawPluginApi } from "../api.js";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  resolveM365AccountForIdentity,
  resolveM365PluginConfig,
  type M365ResolvedAccountConfig,
  type M365ResolvedPluginConfig,
} from "./config.js";
import { createM365CredentialStore, type M365CredentialStore } from "./credentials.js";
import {
  encodeGraphPathSegment,
  M365GraphApiError,
  M365GraphClient,
  type M365Fetch,
  type M365GraphJsonClient,
} from "./graph-client.js";

export type M365ToolDeps = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: M365Fetch;
  now?: () => Date;
  credentialStore?: M365CredentialStore;
  deliverApprovalCard?: (params: {
    cfg: OpenClawConfig;
    to: string;
    card: Record<string, unknown>;
    requesterSenderId?: string | null;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    toolContext?: unknown;
    dryRun?: boolean;
  }) => Promise<unknown>;
  graphClientFactory?: (params: {
    config: M365ResolvedPluginConfig;
    account: M365ResolvedAccountConfig;
  }) => M365GraphJsonClient;
};

function normalizeStringList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).toSorted(
    (left, right) => left.localeCompare(right),
  );
}

export async function resolveM365RuntimeConfig(
  api: OpenClawPluginApi,
  deps: M365ToolDeps,
): Promise<M365ResolvedPluginConfig> {
  const config = await resolveM365PluginConfig({
    pluginConfig: api.pluginConfig,
    config: api.config,
    env: deps.env ?? process.env,
    logger: api.logger,
  });
  if (!config.enabled) {
    throw new Error("M365 plugin is disabled.");
  }
  return config;
}

export function resolveApproverTeamsUserIds(params: {
  config: M365ResolvedPluginConfig;
  explicitApprovers?: string[];
}): string[] {
  return normalizeStringList([
    ...(params.explicitApprovers ?? []),
    ...params.config.approval.teamsUserIds,
  ]);
}

export function resolveM365RuntimeAccount(params: {
  config: M365ResolvedPluginConfig;
  identityId?: string;
}): M365ResolvedAccountConfig {
  return resolveM365AccountForIdentity(params.config, params.identityId);
}

export function createM365JsonGraphClient(params: {
  config: M365ResolvedPluginConfig;
  account: M365ResolvedAccountConfig;
  deps: M365ToolDeps;
}): M365GraphJsonClient {
  const provided = params.deps.graphClientFactory?.({
    config: params.config,
    account: params.account,
  });
  if (provided) {
    return provided;
  }
  return new M365GraphClient({
    config: params.config,
    account: params.account,
    fetchImpl: params.deps.fetchImpl,
    env: params.deps.env,
    nowMs: params.deps.now ? () => params.deps.now?.().getTime() ?? Date.now() : undefined,
    credentialStore:
      params.deps.credentialStore ?? createM365CredentialStore({ env: params.deps.env }),
  });
}

export function assertM365WriteAllowed(params: {
  config: M365ResolvedPluginConfig;
  account: M365ResolvedAccountConfig;
  writeKind: "mail" | "calendar";
  targetId: string;
}): void {
  if (params.account.authMode !== "app-only") {
    return;
  }
  const normalizedTarget = params.targetId.trim().toLowerCase();
  const allowlist =
    params.writeKind === "mail" ? params.config.allowedMailboxes : params.config.allowedCalendars;
  if (allowlist.length === 0) {
    throw new Error(
      `M365 ${params.writeKind} writes are disabled for app-only auth until an explicit allowlist is configured.`,
    );
  }
  if (!allowlist.includes(normalizedTarget)) {
    throw new Error(
      `M365 ${params.writeKind} write target "${params.targetId}" is outside the configured app-only allowlist.`,
    );
  }
}

export async function verifyM365MailWriteScopeProof(params: {
  config: M365ResolvedPluginConfig;
  deps: M365ToolDeps;
}): Promise<void> {
  const probeMailboxUserId = params.config.mailWriteScopeProbeMailboxUserId;
  const appOnlyAccounts = Object.values(params.config.accounts).filter(
    (account) => account.authMode === "app-only",
  );
  if (appOnlyAccounts.length === 0) {
    return;
  }
  if (params.config.allowedMailboxes.length === 0) {
    throw new Error(
      "M365 app-only mail writes require plugins.entries.m365.config.allowedMailboxes.",
    );
  }
  if (!probeMailboxUserId) {
    throw new Error(
      "M365 app-only mail writes require plugins.entries.m365.config.mailWriteScopeProbeMailboxUserId.",
    );
  }
  const normalizedProbe = probeMailboxUserId.trim().toLowerCase();
  if (params.config.allowedMailboxes.includes(normalizedProbe)) {
    throw new Error(
      "M365 mail scope proof probe mailbox must be outside the allowedMailboxes list.",
    );
  }

  for (const account of appOnlyAccounts) {
    const normalizedMailbox = account.mailboxUserId.trim().toLowerCase();
    if (!params.config.allowedMailboxes.includes(normalizedMailbox)) {
      throw new Error(
        `M365 app-only mailbox "${account.mailboxUserId}" must be present in allowedMailboxes.`,
      );
    }
    const client = createM365JsonGraphClient({
      config: params.config,
      account,
      deps: params.deps,
    });
    try {
      await client.requestJson(
        `/users/${encodeGraphPathSegment(probeMailboxUserId)}/mailFolders/inbox/messages`,
        {
          query: {
            $top: 1,
            $select: "id",
          },
        },
      );
      throw new Error(
        `M365 app-only scope proof failed for "${account.accountId}": out-of-scope mailbox "${probeMailboxUserId}" was accessible.`,
      );
    } catch (error) {
      if (error instanceof M365GraphApiError && error.status === 403) {
        continue;
      }
      if (error instanceof Error) {
        throw new Error(
          `M365 app-only scope proof failed for "${account.accountId}": ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}
