import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";
import { forgetCodexInferenceThread } from "./inference-routing.js";
import type {
  CodexThreadForkParams,
  CodexThreadResumeParams,
  CodexThreadStartParams,
  CodexTurnStartParams,
} from "./protocol.js";

type TurnSettings = Pick<
  CodexTurnStartParams,
  | "additionalContext"
  | "cwd"
  | "runtimeWorkspaceRoots"
  | "model"
  | "approvalPolicy"
  | "approvalsReviewer"
  | "sandboxPolicy"
  | "serviceTier"
  | "effort"
  | "personality"
  | "environments"
  | "collaborationMode"
>;

type CodexThreadForkSettings = {
  thread: CodexThreadForkParams;
  turn?: TurnSettings;
};

const clients = defineCodexBuildState(
  "openclaw.codexClientForkSettings",
  () => new WeakMap<CodexAppServerClient, Map<string, CodexThreadForkSettings>>(),
)();

/** The physical client owner initializes and disposes these nonpersistent snapshots. */
export function initializeCodexClientForkSettings(client: CodexAppServerClient): void {
  clients.set(client, new Map());
}

export function forgetCodexClientForkSettings(
  client: CodexAppServerClient,
  threadId?: string,
): void {
  if (threadId === undefined) {
    for (const id of clients.get(client)?.keys() ?? []) {
      forgetCodexInferenceThread(client, id);
    }
    clients.delete(client);
  } else {
    forgetCodexInferenceThread(client, threadId);
    clients.get(client)?.delete(threadId);
  }
}

export function recordCodexThreadForkSettings(
  client: CodexAppServerClient,
  threadId: string,
  params: CodexThreadStartParams | CodexThreadResumeParams,
): void {
  const settings = clients.get(client);
  // Loaded native resumes ignore startup overrides; retain the original prompt carrier.
  if (!settings || settings.has(threadId)) {
    return;
  }
  const permissions = typeof params.permissions === "string" ? params.permissions : undefined;
  // Fork params are a JSON record: absent settings must be omitted, never `undefined`.
  const thread: CodexThreadForkParams = {
    threadId,
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.modelProvider !== undefined ? { modelProvider: params.modelProvider } : {}),
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    ...(params.runtimeWorkspaceRoots !== undefined
      ? { runtimeWorkspaceRoots: params.runtimeWorkspaceRoots }
      : {}),
    ...(params.approvalPolicy !== undefined ? { approvalPolicy: params.approvalPolicy } : {}),
    ...(params.approvalsReviewer !== undefined
      ? { approvalsReviewer: params.approvalsReviewer }
      : {}),
    ...(params.sandbox !== undefined ? { sandbox: params.sandbox } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
    ...(params.serviceTier !== undefined ? { serviceTier: params.serviceTier } : {}),
    ...(params.config !== undefined ? { config: params.config } : {}),
    ...(params.developerInstructions !== undefined
      ? { developerInstructions: params.developerInstructions }
      : {}),
  };
  // Native history already owns base instructions and immutable dynamic declarations.
  settings.set(threadId, { thread });
}

export function recordCodexTurnForkSettings(
  client: CodexAppServerClient,
  params: CodexTurnStartParams,
): void {
  const settings = clients.get(client)?.get(params.threadId);
  if (settings) {
    settings.turn = {
      additionalContext: params.additionalContext,
      cwd: params.cwd,
      runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
      model: params.model,
      approvalPolicy: params.approvalPolicy,
      approvalsReviewer: params.approvalsReviewer,
      sandboxPolicy: params.sandboxPolicy,
      serviceTier: params.serviceTier,
      effort: params.effort,
      personality: params.personality,
      environments: params.environments,
      collaborationMode: params.collaborationMode,
    };
  }
}

export function requireCodexThreadForkSettings(
  client: CodexAppServerClient,
  threadId: string,
): CodexThreadForkSettings & { turn: TurnSettings } {
  const settings = clients.get(client)?.get(threadId);
  if (!settings?.turn) {
    throw new Error(
      "Cache-parity session fork requires a parent turn prepared by this OpenClaw runtime. Send a normal message first.",
    );
  }
  return { ...settings, turn: settings.turn };
}
