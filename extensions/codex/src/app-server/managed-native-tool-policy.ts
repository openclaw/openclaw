import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import {
  CODEX_SESSION_OVERRIDABLE_LAYER_TYPES,
  readCodexEffectiveConfig,
} from "./config-layer-policy.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { isJsonObject } from "./protocol.js";
import {
  releaseLeasedSharedCodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { readCodexManagedRequirements } from "./thread-requests.js";

function requirementsDisableNativeShell(requirements: Record<string, unknown> | null): boolean {
  if (!requirements) {
    return false;
  }
  const features = requirements.featureRequirements ?? requirements.feature_requirements;
  return isJsonObject(features) && features.shell_tool === false;
}

/**
 * Checks whether administrator-managed Codex policy disables native shell use.
 * Unknown results remain fail-closed at the ordinary lifecycle preflight.
 */
export async function resolveCodexManagedNativeShellDenied(params: {
  clientFactory: CodexAppServerClientFactory;
  appServer: CodexAppServerRuntimeOptions;
  authProfileId: string | null | undefined;
  preparedAuth?: CodexAppServerClientOptions["preparedAuth"];
  agentDir: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  cwd: string;
  signal: AbortSignal;
}): Promise<boolean> {
  let client: CodexAppServerClient | undefined;
  try {
    client = await params.clientFactory({
      startOptions: params.appServer.start,
      ...(params.preparedAuth
        ? { preparedAuth: params.preparedAuth }
        : { authProfileId: params.authProfileId }),
      agentDir: params.agentDir,
      config: params.config,
      timeoutMs: params.appServer.requestTimeoutMs,
    });
    const requirements = await readCodexManagedRequirements(client, params.signal);
    if (requirementsDisableNativeShell(requirements)) {
      return true;
    }
    const effectiveConfig = await readCodexEffectiveConfig(client, params.cwd, {
      signal: params.signal,
    });
    const features = effectiveConfig?.config.features;
    return (
      isJsonObject(features) &&
      features.shell_tool === false &&
      !CODEX_SESSION_OVERRIDABLE_LAYER_TYPES.has(
        effectiveConfig?.origins?.["features.shell_tool"]?.name.type ?? "",
      )
    );
  } catch {
    return false;
  } finally {
    if (client) {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  }
}
