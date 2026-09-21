import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import type { BootstrapMode } from "../bootstrap-mode.js";
import { hashCliSessionText } from "../cli-session.js";
import type { EmbeddedContextFile } from "../embedded-agent-helpers.js";

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
  const personal = params.contextFiles.filter((file) =>
    /[\\/]users[\\/][^\\/]+[\\/]USER\.md$/.test(file.path),
  );
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
