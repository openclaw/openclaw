import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import type { BootstrapMode } from "../bootstrap-mode.js";
import { isPrimaryBootstrapRun, resolveWorkspaceBootstrapRouting } from "../bootstrap-routing.js";
import { hashCliSessionText } from "../cli-session.js";
import type { EmbeddedContextFile } from "../embedded-agent-helpers/context-file.js";
import { isWorkspaceBootstrapPending, type WorkspaceBootstrapFile } from "../workspace.js";
import type { RunCliAgentParams } from "./types.js";

export async function resolveCliBootstrapRouting(input: {
  backend: CliBackendConfig;
  params: RunCliAgentParams;
  skipsTurnPreparation: boolean;
  bootstrapFiles: readonly WorkspaceBootstrapFile[];
  canonicalWorkspace: string;
  workspaceDir: string;
  hasBootstrapFileAccess: boolean;
}) {
  if (input.skipsTurnPreparation || !canTransportSystemPrompt(input.backend)) {
    return undefined;
  }
  return resolveWorkspaceBootstrapRouting({
    isWorkspaceBootstrapPending,
    bootstrapFiles: input.bootstrapFiles,
    bootstrapFilesProvideAccess: false,
    bootstrapContextRunKind: input.params.bootstrapContextRunKind,
    trigger: input.params.trigger,
    sessionKey: input.params.sessionKey,
    isPrimaryRun: isPrimaryBootstrapRun(input.params.sessionKey),
    isCanonicalWorkspace: input.canonicalWorkspace === input.workspaceDir,
    effectiveWorkspace: input.workspaceDir,
    resolvedWorkspace: input.workspaceDir,
    hasBootstrapFileAccess: input.hasBootstrapFileAccess,
  });
}

export function canTransportSystemPrompt(backend: CliBackendConfig): boolean {
  return (
    backend.systemPromptWhen !== "never" &&
    Boolean(
      backend.systemPromptArg || backend.systemPromptFileArg || backend.systemPromptFileConfigKey,
    )
  );
}

/** Refresh first-only and live CLI prompts when personal context changes or disappears. */
export function resolveCliBootstrapPromptHash(params: {
  baseHash?: string;
  bootstrapMode: BootstrapMode;
  bootstrapTruncationNotice?: string;
  contextFiles: EmbeddedContextFile[];
}): string | undefined {
  const personal = params.contextFiles.filter((file) => file.personalUser);
  if (
    params.bootstrapMode === "none" &&
    params.bootstrapTruncationNotice === undefined &&
    personal.length === 0
  ) {
    return params.baseHash;
  }
  return hashCliSessionText(
    JSON.stringify([
      params.baseHash ?? null,
      params.bootstrapMode,
      params.bootstrapTruncationNotice !== undefined,
      ...(personal.length ? [personal] : []),
    ]),
  );
}
