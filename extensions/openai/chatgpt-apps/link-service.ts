import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { acquireChatgptAppsSidecarSession } from "./app-server-supervisor.js";
import type { ChatgptAppsResolvedAuth } from "./auth-projector.js";
import { resolveChatgptAppsConfig } from "./config.js";
import {
  groupChatgptAppsInventory,
  resolveChatgptAppLinkCandidate,
  summarizeChatgptApp,
  waitForChatgptAppAccessibility,
  type ChatgptAppInventoryEntry,
  type ChatgptAppLinkReason,
} from "./inventory.js";
import { runCoalescedChatgptLinkOperation } from "./link-state.js";

export const CHATGPT_APP_LINK_FAILURE_REASONS = [
  "app_not_found",
  "auth_unavailable",
  "linking_disabled",
  "missing_account_id",
  "missing_install_url",
  "not_visible_when_unlinked",
  "sidecar_unavailable",
  "timed_out",
] as const;

export type ChatgptAppLinkFailureReason = (typeof CHATGPT_APP_LINK_FAILURE_REASONS)[number];
export type ChatgptAppLinkOpenMode = "auto" | "print_only";

type FailureDetails = {
  reason: ChatgptAppLinkFailureReason;
  message: string;
};

export type ChatgptAppsInventoryToolResult =
  | ({
      status: "ok";
      accountId: string | null;
      inventorySource: "rpc" | "notification" | null;
      updatedAt: string | null;
      total: number;
    } & ReturnType<typeof groupChatgptAppsInventory>)
  | {
      status: "failed";
      reason: ChatgptAppLinkFailureReason;
      message: string;
      accountId: string | null;
    };

export type ChatgptAppLinkToolResult = {
  status: "linked" | "pending" | "failed";
  reason: ChatgptAppLinkFailureReason | ChatgptAppLinkReason | null;
  message: string;
  accountId: string | null;
  installUrl: string | null;
  browserLaunch: {
    mode: ChatgptAppLinkOpenMode;
    attempted: boolean;
    opened: boolean;
  };
  app: ChatgptAppInventoryEntry | null;
  warning: {
    code: "linked_but_locally_disabled";
    message: string;
  } | null;
};

type AcquireLease = typeof acquireChatgptAppsSidecarSession;

function buildInventoryFailureResult(
  params: FailureDetails & { accountId?: string | null },
): ChatgptAppsInventoryToolResult {
  return {
    status: "failed",
    reason: params.reason,
    message: params.message,
    accountId: params.accountId ?? null,
  };
}

function buildLinkFailureResult(
  params: FailureDetails & { accountId?: string | null },
): ChatgptAppLinkToolResult {
  return {
    status: "failed",
    reason: params.reason,
    message: params.message,
    accountId: params.accountId ?? null,
    installUrl: null,
    browserLaunch: {
      mode: "auto" as const,
      attempted: false,
      opened: false,
    },
    app: null,
    warning: null,
  };
}

function resolveFailureFromAuth(
  auth: ChatgptAppsResolvedAuth | null,
  sidecarError: string | null,
  fallbackMessage: string,
): FailureDetails {
  if (auth?.status === "missing-auth") {
    return {
      reason: "auth_unavailable",
      message: auth.message,
    };
  }

  if (auth?.status === "missing-account-id") {
    return {
      reason: "missing_account_id",
      message: auth.message,
    };
  }

  if (auth?.status === "error") {
    return {
      reason: "auth_unavailable",
      message: auth.message,
    };
  }

  if (sidecarError) {
    return {
      reason: "sidecar_unavailable",
      message: sidecarError,
    };
  }

  return {
    reason: "sidecar_unavailable",
    message: fallbackMessage,
  };
}

function buildLinkedButDisabledWarning(entry: ChatgptAppInventoryEntry | null) {
  if (!entry || entry.linkState !== "linked_but_locally_disabled") {
    return null;
  }
  return {
    code: "linked_but_locally_disabled" as const,
    message:
      "The app is linked to ChatGPT, but OpenClaw is configured to keep its tools disabled locally.",
  };
}

export async function listChatgptAppsForLinking(params: {
  config: OpenClawConfig;
  pluginConfig: unknown;
  stateDir: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  forceRefetch?: boolean;
  acquireLease?: AcquireLease;
}): Promise<ChatgptAppsInventoryToolResult> {
  const chatgptAppsConfig = resolveChatgptAppsConfig(params.pluginConfig);
  if (!chatgptAppsConfig.enabled || !chatgptAppsConfig.linking.enabled) {
    return buildInventoryFailureResult({
      reason: "linking_disabled",
      message: "ChatGPT app linking is disabled in the OpenAI plugin config.",
    });
  }

  const acquireLease = params.acquireLease ?? acquireChatgptAppsSidecarSession;
  const lease = await acquireLease({
    stateDir: params.stateDir,
    workspaceDir: params.workspaceDir,
    config: chatgptAppsConfig,
    openclawConfig: params.config,
    env: params.env,
  });

  try {
    const apps = await lease.session.refreshInventory({
      forceRefetch: params.forceRefetch === true,
    });
    const snapshot = lease.session.snapshot();
    const grouped = groupChatgptAppsInventory(apps);

    return {
      status: "ok",
      accountId: snapshot.auth?.status === "ok" ? snapshot.auth.accountId : null,
      inventorySource: snapshot.inventory?.source ?? null,
      updatedAt: snapshot.inventory?.updatedAt ?? null,
      total: apps.length,
      ...grouped,
    };
  } catch (error) {
    const snapshot = lease.session.snapshot();
    const failure = resolveFailureFromAuth(
      snapshot.auth,
      snapshot.sidecarError,
      error instanceof Error ? error.message : String(error),
    );
    return buildInventoryFailureResult({
      ...failure,
      accountId: snapshot.auth?.status === "ok" ? snapshot.auth.accountId : null,
    });
  } finally {
    await lease.release();
  }
}

export async function linkChatgptApp(params: {
  config: OpenClawConfig;
  pluginConfig: unknown;
  stateDir: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  appId: string;
  waitForCompletion: boolean;
  timeoutSeconds?: number;
  openMode: ChatgptAppLinkOpenMode;
  acquireLease?: AcquireLease;
  openUrl?: (url: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ChatgptAppLinkToolResult> {
  const chatgptAppsConfig = resolveChatgptAppsConfig(params.pluginConfig);
  if (!chatgptAppsConfig.enabled || !chatgptAppsConfig.linking.enabled) {
    return buildLinkFailureResult({
      reason: "linking_disabled",
      message: "ChatGPT app linking is disabled in the OpenAI plugin config.",
    });
  }

  const acquireLease = params.acquireLease ?? acquireChatgptAppsSidecarSession;
  const lease = await acquireLease({
    stateDir: params.stateDir,
    workspaceDir: params.workspaceDir,
    config: chatgptAppsConfig,
    openclawConfig: params.config,
    env: params.env,
  });

  try {
    let apps;
    try {
      apps = await lease.session.refreshInventory({ forceRefetch: false });
    } catch (error) {
      const snapshot = lease.session.snapshot();
      const failure = resolveFailureFromAuth(
        snapshot.auth,
        snapshot.sidecarError,
        error instanceof Error ? error.message : String(error),
      );
      return buildLinkFailureResult({
        ...failure,
        accountId: snapshot.auth?.status === "ok" ? snapshot.auth.accountId : null,
      });
    }

    const snapshot = lease.session.snapshot();
    const auth = snapshot.auth;
    if (!auth || auth.status !== "ok") {
      const failure = resolveFailureFromAuth(
        auth,
        snapshot.sidecarError,
        "ChatGPT app linking requires a projected OpenAI Codex OAuth session.",
      );
      return buildLinkFailureResult(failure);
    }

    const operationKey = `${auth.accountId}:${params.appId.trim()}`;
    return await runCoalescedChatgptLinkOperation(operationKey, async () => {
      const candidate = resolveChatgptAppLinkCandidate(apps, params.appId);

      if (candidate.status === "blocked") {
        return buildLinkFailureResult({
          reason: candidate.reason === "app_not_found" ? "app_not_found" : candidate.reason,
          message:
            candidate.reason === "app_not_found"
              ? `No ChatGPT app with id "${params.appId.trim()}" was found in the current inventory.`
              : candidate.reason === "missing_install_url"
                ? "This app does not currently expose a ChatGPT install URL."
                : "This app is not available for explicit linking while unlinked.",
          accountId: auth.accountId,
        });
      }

      if (candidate.status === "already_accessible") {
        return {
          status: "linked",
          reason: candidate.reason,
          message: `${candidate.entry.name} is already accessible in ChatGPT.`,
          accountId: auth.accountId,
          installUrl: candidate.entry.installUrl,
          browserLaunch: {
            mode: params.openMode,
            attempted: false,
            opened: false,
          },
          app: candidate.entry,
          warning: buildLinkedButDisabledWarning(candidate.entry),
        } satisfies ChatgptAppLinkToolResult;
      }

      const timeoutMs =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.trunc(params.timeoutSeconds * 1000))
          : chatgptAppsConfig.linking.waitTimeoutMs;
      const browserAttempted = params.openMode === "auto";
      const browserOpened =
        params.openMode === "auto" && candidate.entry.installUrl
          ? await (params.openUrl?.(candidate.entry.installUrl) ?? Promise.resolve(false))
          : false;

      if (!params.waitForCompletion) {
        return {
          status: "pending",
          reason: null,
          message: browserOpened
            ? `Opened the ChatGPT link flow for ${candidate.entry.name}.`
            : `Open the returned URL to finish linking ${candidate.entry.name} in ChatGPT.`,
          accountId: auth.accountId,
          installUrl: candidate.entry.installUrl,
          browserLaunch: {
            mode: params.openMode,
            attempted: browserAttempted,
            opened: browserOpened,
          },
          app: candidate.entry,
          warning: null,
        } satisfies ChatgptAppLinkToolResult;
      }

      const accessibleApp = await waitForChatgptAppAccessibility({
        session: lease.session,
        appId: candidate.app.id,
        timeoutMs,
        pollIntervalMs: chatgptAppsConfig.linking.pollIntervalMs,
        now: params.now,
        sleep: params.sleep,
      });

      if (!accessibleApp) {
        return {
          status: "pending",
          reason: "timed_out",
          message:
            "The ChatGPT link flow did not report completion before the wait timeout expired.",
          accountId: auth.accountId,
          installUrl: candidate.entry.installUrl,
          browserLaunch: {
            mode: params.openMode,
            attempted: browserAttempted,
            opened: browserOpened,
          },
          app: candidate.entry,
          warning: null,
        } satisfies ChatgptAppLinkToolResult;
      }

      const linkedEntry = summarizeChatgptApp(accessibleApp);
      return {
        status: "linked",
        reason: null,
        message: `${linkedEntry.name} is now accessible in ChatGPT.`,
        accountId: auth.accountId,
        installUrl: linkedEntry.installUrl,
        browserLaunch: {
          mode: params.openMode,
          attempted: browserAttempted,
          opened: browserOpened,
        },
        app: linkedEntry,
        warning: buildLinkedButDisabledWarning(linkedEntry),
      } satisfies ChatgptAppLinkToolResult;
    });
  } finally {
    await lease.release();
  }
}
