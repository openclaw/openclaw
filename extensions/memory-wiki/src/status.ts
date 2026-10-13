import fs from "node:fs/promises";
import path from "node:path";
import { listActiveMemoryPublicArtifacts } from "openclaw/plugin-sdk/memory-host-core";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import type { OpenClawConfig } from "../api.js";
import { listMemoryWikiPagePaths } from "./bounded-walk.js";
import { filterMemoryWikiBridgeArtifacts, resolveMemoryWikiVaultAgentId } from "./bridge.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { toWikiPageSummary, type WikiPageKind } from "./markdown.js";
import { probeObsidianCli } from "./obsidian.js";

const STATUS_WARNING_FIXES = {
  "vault-missing": "Run `openclaw wiki init` to create the vault layout.",
  "obsidian-cli-missing": "Install the official Obsidian CLI or disable `obsidian.useOfficialCli`.",
  "bridge-disabled":
    "Enable `plugins.entries.memory-wiki.config.bridge.enabled` or switch vaultMode away from `bridge`.",
  "bridge-artifacts-missing":
    "Use a memory plugin that exports public artifacts, create/import memory artifacts first, or switch the wiki back to isolated mode.",
  "unsafe-local-disabled":
    "Enable `unsafeLocal.allowPrivateMemoryCoreAccess` or switch vaultMode away from `unsafe-local`.",
  "unsafe-local-paths-missing":
    "Add explicit `unsafeLocal.paths` entries before running unsafe-local imports.",
  "unsafe-local-without-mode":
    "Disable private memory-core access unless you explicitly want unsafe-local mode.",
};

type MemoryWikiStatusWarning = {
  code: keyof typeof STATUS_WARNING_FIXES;
  message: string;
};

export type MemoryWikiStatus = Awaited<ReturnType<typeof resolveMemoryWikiStatus>>;

export type MemoryWikiDoctorReport = ReturnType<typeof buildMemoryWikiDoctorReport>;

type ResolveMemoryWikiStatusDeps = {
  appConfig?: OpenClawConfig;
  callerAgentId?: string;
  pathExists?: (inputPath: string) => Promise<boolean>;
  listPublicArtifacts?: typeof listActiveMemoryPublicArtifacts;
  resolveCommand?: (command: string) => Promise<string | null>;
};

function createEmptyVaultCounts() {
  const pageCounts: Record<WikiPageKind, number> = {
    entity: 0,
    concept: 0,
    source: 0,
    synthesis: 0,
    report: 0,
  };
  const sourceCounts = {
    native: 0,
    bridge: 0,
    bridgeEvents: 0,
    unsafeLocal: 0,
    other: 0,
  };
  return { pageCounts, sourceCounts };
}

async function collectVaultCounts(vaultPath: string) {
  const { pageCounts, sourceCounts } = createEmptyVaultCounts();
  const dirs = ["entities", "concepts", "sources", "syntheses", "reports"] as const;
  for (const dir of dirs) {
    for (const relativePath of await listMemoryWikiPagePaths(vaultPath, dir)) {
      const absolutePath = path.join(vaultPath, relativePath);
      const raw = await fs.readFile(absolutePath, "utf8").catch(() => null);
      if (raw === null) {
        continue;
      }
      const page = toWikiPageSummary({
        absolutePath,
        relativePath,
        raw,
      });
      if (!page) {
        continue;
      }
      pageCounts[page.kind] += 1;
      if (page.kind !== "source") {
        continue;
      }
      if (page.sourceType === "memory-bridge-events") {
        sourceCounts.bridgeEvents += 1;
      } else if (page.sourceType === "memory-bridge") {
        sourceCounts.bridge += 1;
      } else if (
        page.provenanceMode === "unsafe-local" ||
        page.sourceType === "memory-unsafe-local"
      ) {
        sourceCounts.unsafeLocal += 1;
      } else if (!page.sourceType) {
        sourceCounts.native += 1;
      } else {
        sourceCounts.other += 1;
      }
    }
  }
  return { pageCounts, sourceCounts };
}

function buildWarnings(params: {
  config: ResolvedMemoryWikiConfig;
  bridgePublicArtifactCount: number | null;
  vaultExists: boolean;
  obsidianCommand: string | null;
}): MemoryWikiStatusWarning[] {
  const { config, bridgePublicArtifactCount, vaultExists, obsidianCommand } = params;
  const rules: Array<[boolean, MemoryWikiStatusWarning["code"], string]> = [
    [!vaultExists, "vault-missing", "Wiki vault has not been initialized yet."],
    [
      config.obsidian.enabled && config.obsidian.useOfficialCli && !obsidianCommand,
      "obsidian-cli-missing",
      "Obsidian CLI is enabled in config but `obsidian` is not available on PATH.",
    ],
    [
      config.vaultMode === "bridge" && !config.bridge.enabled,
      "bridge-disabled",
      "vaultMode is `bridge` but bridge.enabled is false.",
    ],
    [
      config.vaultMode === "bridge" &&
        config.bridge.enabled &&
        config.bridge.readMemoryArtifacts &&
        bridgePublicArtifactCount === 0,
      "bridge-artifacts-missing",
      "Bridge mode is enabled but the active memory plugin is not exporting any public memory artifacts yet.",
    ],
    [
      config.vaultMode === "unsafe-local" && !config.unsafeLocal.allowPrivateMemoryCoreAccess,
      "unsafe-local-disabled",
      "vaultMode is `unsafe-local` but private memory-core access is disabled.",
    ],
    [
      config.vaultMode === "unsafe-local" &&
        config.unsafeLocal.allowPrivateMemoryCoreAccess &&
        config.unsafeLocal.paths.length === 0,
      "unsafe-local-paths-missing",
      "unsafe-local access is enabled but no private paths are configured.",
    ],
    [
      config.vaultMode !== "unsafe-local" && config.unsafeLocal.allowPrivateMemoryCoreAccess,
      "unsafe-local-without-mode",
      "Private memory-core access is enabled outside unsafe-local mode.",
    ],
  ];
  return rules.flatMap(([matches, code, message]) => (matches ? [{ code, message }] : []));
}

export async function resolveMemoryWikiStatus(
  config: ResolvedMemoryWikiConfig,
  deps?: ResolveMemoryWikiStatusDeps,
) {
  const agentId = resolveMemoryWikiVaultAgentId(config);
  const exists = deps?.pathExists ?? pathExists;
  const vaultExists = await exists(config.vault.path);
  const bridgePublicArtifactCount =
    deps?.appConfig &&
    config.vaultMode === "bridge" &&
    config.bridge.enabled &&
    config.bridge.readMemoryArtifacts
      ? filterMemoryWikiBridgeArtifacts({
          config,
          callerAgentId: deps.callerAgentId,
          artifacts: await (deps.listPublicArtifacts ?? listActiveMemoryPublicArtifacts)({
            cfg: deps.appConfig,
          }),
        }).length
      : null;
  const obsidianProbe = await probeObsidianCli({ resolveCommand: deps?.resolveCommand });
  const counts = vaultExists
    ? await collectVaultCounts(config.vault.path)
    : createEmptyVaultCounts();

  return {
    vaultScope: config.vault.scope,
    agentId,
    vaultMode: config.vaultMode,
    renderMode: config.vault.renderMode,
    vaultPath: config.vault.path,
    vaultExists,
    bridge: config.bridge,
    bridgePublicArtifactCount,
    obsidianCli: {
      enabled: config.obsidian.enabled,
      requested: config.obsidian.enabled && config.obsidian.useOfficialCli,
      available: obsidianProbe.available,
      command: obsidianProbe.command,
    },
    unsafeLocal: {
      allowPrivateMemoryCoreAccess: config.unsafeLocal.allowPrivateMemoryCoreAccess,
      pathCount: config.unsafeLocal.paths.length,
    },
    pageCounts: counts.pageCounts,
    sourceCounts: counts.sourceCounts,
    warnings: buildWarnings({
      config,
      bridgePublicArtifactCount,
      vaultExists,
      obsidianCommand: obsidianProbe.command,
    }),
  };
}

export function buildMemoryWikiDoctorReport(status: MemoryWikiStatus) {
  const fixes = status.warnings.map((warning) => ({
    code: warning.code,
    message: Object.hasOwn(STATUS_WARNING_FIXES, warning.code)
      ? STATUS_WARNING_FIXES[warning.code]
      : STATUS_WARNING_FIXES["unsafe-local-without-mode"],
  }));
  return {
    healthy: status.warnings.length === 0,
    warningCount: status.warnings.length,
    status,
    fixes,
  };
}

export function renderMemoryWikiStatus(status: MemoryWikiStatus): string {
  const lines = [
    `Wiki vault mode: ${status.vaultMode}`,
    `Vault scope: ${status.vaultScope}${status.agentId ? ` (${status.agentId})` : ""}`,
    `Vault: ${status.vaultExists ? "ready" : "missing"} (${status.vaultPath})`,
    `Render mode: ${status.renderMode}`,
    `Obsidian CLI: ${status.obsidianCli.available ? "available" : "missing"}${status.obsidianCli.requested ? " (requested)" : ""}`,
    `Bridge: ${status.bridge.enabled ? "enabled" : "disabled"}${typeof status.bridgePublicArtifactCount === "number" ? ` (${status.bridgePublicArtifactCount} exported artifact${status.bridgePublicArtifactCount === 1 ? "" : "s"})` : ""}`,
    `Unsafe local: ${status.unsafeLocal.allowPrivateMemoryCoreAccess ? `enabled (${status.unsafeLocal.pathCount} paths)` : "disabled"}`,
    `Pages: ${status.pageCounts.source} sources, ${status.pageCounts.entity} entities, ${status.pageCounts.concept} concepts, ${status.pageCounts.synthesis} syntheses, ${status.pageCounts.report} reports`,
    `Source provenance: ${status.sourceCounts.native} native, ${status.sourceCounts.bridge} bridge, ${status.sourceCounts.bridgeEvents} bridge-events, ${status.sourceCounts.unsafeLocal} unsafe-local, ${status.sourceCounts.other} other`,
  ];

  if (status.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of status.warnings) {
      lines.push(`- ${warning.message}`);
    }
  }

  return lines.join("\n");
}

export function renderMemoryWikiDoctor(report: MemoryWikiDoctorReport): string {
  const lines = [
    report.healthy ? "Wiki doctor: healthy" : `Wiki doctor: ${report.warningCount} issue(s) found`,
    "",
    renderMemoryWikiStatus(report.status),
  ];

  if (report.fixes.length > 0) {
    lines.push("", "Suggested fixes:");
    for (const fix of report.fixes) {
      lines.push(`- ${fix.message}`);
    }
  }

  return lines.join("\n");
}
