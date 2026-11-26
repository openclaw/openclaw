import type { CopilotClient } from "@github/copilot-sdk";
import type {
  AgentHarness,
  AgentHarnessModelCatalogParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { resolveCopilotAuth } from "./auth-bridge.js";
import type { CopilotClientPool, PooledClient } from "./runtime.js";

type ModelList = Awaited<ReturnType<CopilotClient["rpc"]["models"]["list"]>>;
type ModelCatalogResult = Awaited<ReturnType<NonNullable<AgentHarness["loadModelCatalog"]>>>;

function toCatalogEntries(result: ModelList, runtime: string): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const model of result.models) {
    if (model.policy?.state === "disabled" || model.policy?.state === "unconfigured") {
      continue;
    }
    const entry: ModelCatalogEntry = {
      id: model.id,
      name: model.name,
      provider: "github-copilot",
      nativeRuntime: runtime,
      input: model.capabilities.supports?.vision ? ["text", "image"] : ["text"],
    };
    if (
      model.capabilities.supports?.reasoningEffort !== undefined ||
      model.capabilities.supports?.thinking !== undefined
    ) {
      entry.reasoning =
        model.capabilities.supports.reasoningEffort === true ||
        model.capabilities.supports.thinking === true;
    }
    if (model.capabilities.limits?.max_context_window_tokens) {
      entry.contextWindow = model.capabilities.limits.max_context_window_tokens;
    }
    if (model.supportedReasoningEfforts) {
      entry.compat = { supportedReasoningEfforts: model.supportedReasoningEfforts };
    }
    entries.push(entry);
  }
  // Keep tier selection with the request's execution configuration.
  const fusionAvailable = result.auto?.tiers.some(
    (tier) =>
      tier.status.enabled &&
      tier.status.pickerVisible !== false &&
      (tier.fusionTier === "standard" || tier.fusionTier === "high" || tier.fusionTier === "max"),
  );
  if (fusionAvailable && !entries.some((entry) => entry.id === "fusion")) {
    entries.push({
      id: "fusion",
      name: "Copilot Fusion",
      provider: "github-copilot",
      nativeRuntime: runtime,
    });
  }
  return entries;
}

export async function loadCopilotModelCatalog(
  params: AgentHarnessModelCatalogParams,
  pool: CopilotClientPool,
  runtime: string,
): Promise<ModelCatalogResult> {
  const timeout = buildTimeoutAbortSignal({
    timeoutMs: 30_000,
    operation: "Copilot model discovery",
  });
  let handle: PooledClient | undefined;
  try {
    const authScope = {
      provider: "github-copilot",
      cfg: params.config,
      agentDir: params.agentDir,
    };
    const credential = await racePromiseWithAbortSignal(
      () =>
        resolveApiKeyForProvider({
          ...authScope,
          workspaceDir: params.workspaceDir,
          signal: timeout.signal,
        }),
      timeout.signal,
    );
    const auth = resolveCopilotAuth({
      agentId: params.agentId,
      agentDir: params.agentDir,
      resolvedApiKey: credential.apiKey,
      authProfileId: credential.profileId,
    });
    const acquisition = pool.acquire(auth, {
      copilotHome: auth.copilotHome,
      useLoggedInUser: auth.authMode === "useLoggedInUser",
      ...(auth.gitHubToken ? { gitHubToken: auth.gitHubToken } : {}),
    });
    try {
      handle = await racePromiseWithAbortSignal(acquisition, timeout.signal);
    } catch (error) {
      void acquisition.then((lateHandle) => pool.release(lateHandle)).catch(() => undefined);
      throw error;
    }
    const client = handle.client;
    await racePromiseWithAbortSignal(() => client.start(), timeout.signal);
    // listModels() drops the account's Auto/Fusion descriptors.
    const result = await racePromiseWithAbortSignal(
      () => client.rpc.models.list({}),
      timeout.signal,
    );
    const entries = toCatalogEntries(result, runtime);
    return {
      entries,
      outcomes: [
        {
          provider: "github-copilot",
          ...(credential.profileId ? { profileId: credential.profileId } : {}),
          status: "ready",
          listedModelIds: entries.map((entry) => entry.id),
        },
      ],
    };
  } catch {
    // This inventory belongs to GitHub Copilot even when the runtime also serves BYOK models.
    return { entries: [], outcomes: [{ provider: "github-copilot", status: "unavailable" }] };
  } finally {
    timeout.cleanup();
    if (handle) {
      await pool.release(handle);
    }
  }
}
