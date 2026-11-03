import type { ToolsGitHubAuthorizeStartResult } from "@openclaw/gateway-protocol";
import type {
  ControlUiSettingsClient as GatewayBrowserClient,
  ControlUiSettingsConfigMutation,
} from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type GitHubSharedScope = "system" | "agent";
export type GitHubIdentityScope = "personal" | GitHubSharedScope;
export type GitHubIdentityDraft = { token: string; name: string; email: string };
type GitHubConnectionOwner =
  | { kind: "personal"; profileId: string }
  | { kind: "shared"; scope: GitHubSharedScope; agentId: string };
export type GitHubConnectionTarget =
  | Extract<GitHubConnectionOwner, { kind: "personal" }>
  | (Extract<GitHubConnectionOwner, { kind: "shared" }> & {
      config: { system?: unknown; agent?: unknown } | null;
      profileId: string | null;
    });

export type RequestOwner = {
  client: GatewayBrowserClient;
  target: GitHubConnectionOwner;
  clientRevision: number;
  requestRevision: number;
};
export type SharedRequestOwner = RequestOwner & {
  target: Extract<GitHubConnectionOwner, { kind: "shared" }>;
};

export type GitHubAuthorizationState =
  | { phase: "idle" }
  | { phase: "starting" | "cancelling" }
  | (ToolsGitHubAuthorizeStartResult & {
      phase: "code" | "pending" | "network_error" | "cancelling" | "finishing" | "cancel_error";
      displayExpiresAtMs: number;
      slowedDown?: boolean;
      message?: string;
    })
  | {
      phase: "access_denied" | "expired" | "incorrect_device_code" | "failed";
      message?: string;
    };

export type AuthorizationOperation = {
  owner: RequestOwner;
  controller: AbortController;
  start?: ToolsGitHubAuthorizeStartResult;
  displayExpiresAtMs?: number;
  timer?: ReturnType<typeof setTimeout>;
  cancelRequested?: boolean;
  cancelInFlight?: boolean;
  pollInFlight?: boolean;
  cancelTooLate?: boolean;
  cancelError?: string;
};

export type GitHubIdentityDependencies = {
  authorizationSucceeded?: () => void;
  translate: (key: string, params?: Record<string, string>) => string;
  confirm: (options: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
  formatError: (error: unknown) => string;
  runExternalMutation?: ControlUiSettingsConfigMutation;
};

export function readGitHubIdentityDraft(value: unknown): GitHubIdentityDraft {
  const github = isRecord(value) ? value : undefined;
  const gitAuthor = isRecord(github?.gitAuthor) ? github.gitAuthor : undefined;
  return {
    token: "",
    name: typeof gitAuthor?.name === "string" ? gitAuthor.name : "",
    email: typeof gitAuthor?.email === "string" ? gitAuthor.email : "",
  };
}

export function githubConnectionOwnerKey(target: GitHubConnectionTarget | null): string {
  return JSON.stringify(
    target?.kind === "shared"
      ? { kind: target.kind, agentId: target.agentId, profileId: target.profileId }
      : target,
  );
}

export function githubAuthorizationMethod(
  owner: RequestOwner,
  operation: "start" | "poll" | "cancel",
) {
  return `${owner.target.kind === "personal" ? "users" : "tools"}.github.authorize.${operation}`;
}

export function cancelAuthorizationRequest(operation: AuthorizationOperation): void {
  if (!operation.start?.requestId) {
    return;
  }
  void operation.owner.client
    .request(githubAuthorizationMethod(operation.owner, "cancel"), {
      requestId: operation.start.requestId,
    })
    .catch(() => undefined);
}
