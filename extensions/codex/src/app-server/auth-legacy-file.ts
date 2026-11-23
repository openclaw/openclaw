import fsSync from "node:fs";
import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-registration";
import { readSecretFileSync } from "openclaw/plugin-sdk/secret-file";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  CODEX_AUTH_JSON_FILENAME,
  resolveCodexAppServerFallbackApiKeyCacheKey,
} from "./auth-cache-key.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import type { CodexAppServerAuthRequirement } from "./auth-types.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";

export function assertNoUnimportedAgentCodexAuthFile(params: {
  startOptions: CodexAppServerStartOptions;
  agentId?: string;
  agentDir?: string;
  authRequirement?: CodexAppServerAuthRequirement;
}): void {
  // Ephemeral stdio starts cannot load this stale file, and the shared-client key
  // separates auth requirements plus fallback identities. Preserve the supported
  // stdio API-key login instead of turning a leftover file into a hard failure.
  if (
    (params.authRequirement === "api-key" || params.authRequirement === "environment-api-key") &&
    resolveCodexAppServerFallbackApiKeyCacheKey({
      startOptions: params.startOptions,
      allowNativeAuthFile: params.authRequirement === "api-key",
    })
  ) {
    return;
  }
  if (params.startOptions.transport !== "stdio" || params.startOptions.homeScope === "user") {
    return;
  }
  const codexHome = resolveCodexAppServerHomeDir(params.agentDir);
  const authPath = path.join(codexHome, CODEX_AUTH_JSON_FILENAME);
  // OpenClaw-owned starts force ephemeral Codex auth, so this file would otherwise be
  // ignored and the operator would receive only the downstream authentication error.
  if (!fsSync.existsSync(authPath)) {
    return;
  }
  try {
    const auth: unknown = JSON.parse(readSecretFileSync(authPath, "Codex auth"));
    // An empty legacy object has nothing to migrate; leave the file and auth ownership alone.
    if (isRecord(auth) && Object.keys(auth).length === 0) {
      return;
    }
  } catch {
    // Unreadable or malformed files still need the existing recovery diagnostic.
  }
  const targetAgentId = params.agentId?.trim() || "<agent-id>";
  throw new AgentHarnessPreflightError(
    `A Codex auth file exists at ${authPath}, but agent-scoped Codex runs use OpenClaw's auth store and do not read that file. Preview only that credential import with \`openclaw migrate plan codex --from <codex-home> --agent ${targetAgentId} --include-secrets --item auth:openai\`, then run \`openclaw migrate apply codex --from <codex-home> --agent ${targetAgentId} --include-secrets --item auth:openai --yes\`. If the plan finds no credentials, remove the stale auth file.`,
  );
}
