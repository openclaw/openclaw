import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { subagentAttachmentRootForRun } from "./subagents/subagent-attachment-paths.js";
import { resolveOpenClawToolsFsPolicy, type ToolFsPolicy } from "./tool-fs-policy.js";

/**
 * Callers that build OpenClaw tools without an fsPolicy (Gateway loopback, skill dispatch,
 * the deprecated sync factory) get the same policy the embedded runner would derive. Omission
 * must never read as "unrestricted": the delegate tool grants Full Access without it.
 */
function resolveCapturedOpenClawToolsFsPolicy(
  options: Pick<
    OpenClawToolsOptions,
    "fsPolicy" | "config" | "sessionPermissionPolicy" | "runSessionKey" | "agentSessionKey"
  >,
  sessionAgentId: string,
): ToolFsPolicy | undefined {
  return (
    options.fsPolicy ??
    resolveOpenClawToolsFsPolicy({
      cfg: options.config,
      agentId: sessionAgentId,
      sessionPermissionPolicy: options.sessionPermissionPolicy,
      attachmentReadRoot: subagentAttachmentRootForRun(
        sessionAgentId,
        options.runSessionKey ?? options.agentSessionKey,
      ),
    })
  );
}

/** Preserve caller options while capturing a policy once for every constructed tool. */
export function withCapturedOpenClawToolsFsPolicy(
  options: OpenClawToolsOptions | undefined,
  sessionAgentId: string,
): OpenClawToolsOptions {
  return {
    ...options,
    fsPolicy: resolveCapturedOpenClawToolsFsPolicy(options ?? {}, sessionAgentId),
  };
}
