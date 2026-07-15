// ClickClack plugin module implements shared setup connection verification.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/setup";
import { resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient } from "./http-client.js";
import { resolveWorkspaceId } from "./resolve.js";
import type { CoreConfig, ResolvedClickClackAccount } from "./types.js";

export type ClickClackSetupConnectionResult =
  | { status: "connected"; handle: string; workspaceName: string }
  | { status: "invalid-token" }
  | { status: "workspace-not-found"; workspace: string }
  | { status: "failed"; error: string }
  | { status: "skipped-env-token" }
  | { status: "skipped-unconfigured" };

function isHttpStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === status
  );
}

function isWorkspaceNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("ClickClack workspace not found:");
}

function usesUnavailableImplicitEnvToken(
  account: ResolvedClickClackAccount,
  tokenOverride: string,
): boolean {
  return (
    account.accountId === DEFAULT_ACCOUNT_ID &&
    Boolean(account.baseUrl && account.workspace) &&
    !tokenOverride &&
    !account.token &&
    !hasConfiguredSecretInput(account.config.token) &&
    !account.config.tokenFile?.trim()
  );
}

export async function checkClickClackSetupConnection(params: {
  cfg: CoreConfig;
  accountId?: string;
  token?: string;
}): Promise<ClickClackSetupConnectionResult> {
  let workspaceInput = "";
  try {
    const account = resolveClickClackAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });
    workspaceInput = account.workspace;
    const token = params.token?.trim() || account.token;
    if (usesUnavailableImplicitEnvToken(account, token)) {
      return { status: "skipped-env-token" };
    }
    if (!account.baseUrl || !account.workspace || !token) {
      return { status: "skipped-unconfigured" };
    }

    const client = createClickClackClient({
      baseUrl: account.baseUrl,
      token,
    });
    const me = await client.me();
    const workspaceId = await resolveWorkspaceId(client, account.workspace);
    const workspaces = await client.workspaces();
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      throw new Error(`ClickClack workspace not found: ${account.workspace}`);
    }
    return {
      status: "connected",
      handle: me.handle,
      workspaceName: workspace.name,
    };
  } catch (error) {
    if (isHttpStatus(error, 401)) {
      return { status: "invalid-token" };
    }
    if (isWorkspaceNotFound(error)) {
      return {
        status: "workspace-not-found",
        workspace: workspaceInput,
      };
    }
    return {
      status: "failed",
      error: formatErrorMessage(error),
    };
  }
}
