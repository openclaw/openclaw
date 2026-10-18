import fs from "node:fs/promises";
import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-registration";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import { resolveCompleteComputerUseArtifactCandidate } from "./computer-use-artifact-candidate.js";
import { ensureCodexManagedBundledMarketplace } from "./computer-use-marketplace.js";
import { ensureOwnedCodexHome } from "./computer-use-service-path.js";
import { ensureCodexComputerUseServiceApp } from "./computer-use-service.js";
import { reconcileManagedCodexComputerUseCache } from "./computer-use-unified.js";
import type { CodexAppServerStartOptions, CodexPluginConfig } from "./config-contracts.js";
import { resolveCodexComputerUseConfig } from "./config-runtime.js";
import { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";

const MAX_COMPUTER_USE_ARTIFACT_OWNERS = 128;
const activeComputerUseArtifactReconciliations = new Map<
  string,
  { appliedCacheBinding?: string; active: number; tail: Promise<void> }
>();

/** Reconciles Computer Use artifacts for the exact managed command about to start. */
export async function reconcileCodexComputerUseStartArtifacts(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir?: string;
  pluginConfig?: CodexPluginConfig;
  ownsIsolatedCodexHome?: boolean;
  desktopGeneration?: CodexDesktopGeneration;
  assertCurrent?: () => void;
  forceCacheRefresh?: boolean;
}): Promise<void> {
  if (params.startOptions.transport !== "stdio") {
    return;
  }
  const codexHome = resolveCodexAppServerLocalHomeDir(params.startOptions, params.agentDir);
  const key = path.resolve(codexHome);
  let owner = activeComputerUseArtifactReconciliations.get(key);
  if (!owner) {
    owner = { active: 0, tail: Promise.resolve() };
  } else {
    activeComputerUseArtifactReconciliations.delete(key);
  }
  activeComputerUseArtifactReconciliations.set(key, owner);
  owner.active += 1;
  const assertCurrent = () => params.assertCurrent?.();
  const operation = owner.tail.then(async () => {
    assertCurrent();
    const appliedCacheBinding = await reconcileCodexComputerUseStartArtifactsOnce({
      ...params,
      codexHome,
      assertCurrent,
      previousCacheBinding: owner.appliedCacheBinding,
    });
    assertCurrent();
    owner.appliedCacheBinding = appliedCacheBinding;
  });
  owner.tail = operation.catch(() => undefined);
  try {
    await operation;
  } finally {
    owner.active -= 1;
    pruneComputerUseArtifactOwners();
  }
}

async function reconcileCodexComputerUseStartArtifactsOnce(
  params: Parameters<typeof reconcileCodexComputerUseStartArtifacts>[0] & {
    codexHome: string;
    assertCurrent: () => void;
    previousCacheBinding?: string;
  },
): Promise<string | undefined> {
  const codexHome = params.codexHome;
  const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig: params.pluginConfig });
  const ownsIsolatedCodexHome =
    params.ownsIsolatedCodexHome ??
    (params.startOptions.homeScope !== "user" && !params.startOptions.env?.CODEX_HOME?.trim());
  const shouldProvisionComputerUse =
    computerUseConfig.enabled && computerUseConfig.autoInstall && ownsIsolatedCodexHome;
  const provisioningAgentDir = shouldProvisionComputerUse ? params.agentDir : undefined;
  if (shouldProvisionComputerUse && !provisioningAgentDir) {
    throw new Error("Managed Codex Computer Use requires an OpenClaw agent directory");
  }
  if (provisioningAgentDir) {
    await ensureOwnedCodexHome(codexHome, provisioningAgentDir);
  } else {
    await fs.mkdir(codexHome, { recursive: true });
  }
  const desktopCandidates = resolveMacOSDesktopCodexAppPathCandidates();
  const exactDesktopCandidate = desktopCandidates.find(
    (candidate) =>
      path.resolve(candidate.appServerCommandPath) === path.resolve(params.startOptions.command),
  );
  const usesManagedBundledMarketplace =
    !computerUseConfig.marketplaceSource &&
    !computerUseConfig.marketplacePath &&
    !computerUseConfig.marketplaceName;
  const needsBundledMarketplace =
    usesManagedBundledMarketplace ||
    (computerUseConfig.pluginCacheMode === "shared" &&
      !computerUseConfig.marketplaceName &&
      !computerUseConfig.marketplacePath);
  const artifactCandidate = shouldProvisionComputerUse
    ? await resolveCompleteComputerUseArtifactCandidate({
        candidates: exactDesktopCandidate ? [exactDesktopCandidate] : desktopCandidates,
        needsBundledMarketplace,
      })
    : exactDesktopCandidate;
  params.assertCurrent();
  let marketplacePath: string | undefined;
  if (provisioningAgentDir) {
    if (desktopCandidates.length > 0 && !artifactCandidate) {
      throw new CodexComputerUseCandidateArtifactsUnavailableError();
    }
    try {
      marketplacePath = usesManagedBundledMarketplace
        ? await ensureCodexManagedBundledMarketplace({
            codexHome,
            ownershipRoot: provisioningAgentDir,
            computerUsePluginName: computerUseConfig.pluginName,
            computerUseMcpServerName: computerUseConfig.mcpServerName,
            desktopFingerprint: params.desktopGeneration?.fingerprint,
            forceRefresh: params.forceCacheRefresh,
            ...(artifactCandidate
              ? {
                  appServerCommand: artifactCandidate.appServerCommandPath,
                  candidates: [artifactCandidate],
                  ownershipCandidates: desktopCandidates,
                }
              : {}),
            assertCurrent: params.assertCurrent,
          })
        : undefined;
      params.assertCurrent();
      if (usesManagedBundledMarketplace && desktopCandidates.length > 0 && !marketplacePath) {
        throw new CodexComputerUseCandidateArtifactsUnavailableError();
      }
      const service = await ensureCodexComputerUseServiceApp({
        codexHome,
        ownershipRoot: params.agentDir,
        ...(artifactCandidate
          ? {
              appServerCommand: artifactCandidate.appServerCommandPath,
              sourceAppCandidates: artifactCandidate.computerUseServiceAppPaths,
            }
          : {}),
        assertCurrent: params.assertCurrent,
      });
      params.assertCurrent();
      if (desktopCandidates.length > 0 && service.status === "source_missing") {
        throw new CodexComputerUseCandidateArtifactsUnavailableError();
      }
    } catch (error) {
      params.assertCurrent();
      if (error instanceof CodexComputerUseCandidateArtifactsUnavailableError) {
        throw error;
      }
      throw new AgentHarnessPreflightError("Codex Computer Use client provisioning failed.", {
        cause: error,
        scope: "harness",
      });
    }
  }
  params.assertCurrent();
  return await reconcileManagedCodexComputerUseCache({
    codexHome,
    config: computerUseConfig,
    ownershipRoot: ownsIsolatedCodexHome ? params.agentDir : undefined,
    managedMarketplacePath: marketplacePath,
    bundledMarketplacePath: artifactCandidate?.bundledMarketplacePath,
    epoch: params.desktopGeneration?.epoch,
    assertCurrent: params.assertCurrent,
    forceRefresh: params.forceCacheRefresh,
    previousCacheBinding: params.previousCacheBinding,
  });
}

function pruneComputerUseArtifactOwners(): void {
  while (activeComputerUseArtifactReconciliations.size > MAX_COMPUTER_USE_ARTIFACT_OWNERS) {
    const inactive = [...activeComputerUseArtifactReconciliations].find(
      ([, owner]) => owner.active === 0,
    );
    if (!inactive) {
      return;
    }
    activeComputerUseArtifactReconciliations.delete(inactive[0]);
  }
}

class CodexComputerUseCandidateArtifactsUnavailableError extends Error {
  readonly code = "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE";

  constructor() {
    super("The selected Codex desktop app does not contain complete Computer Use artifacts.");
    this.name = "CodexComputerUseCandidateArtifactsUnavailableError";
  }
}
