import {
  loadPersistedInstalled,
  mergePackConfig,
  reloadClaworksPacksFromDisk,
} from "./pack-runtime.js";
import {
  hasPackSourcesAvailable,
  repairClaworksRobotPluginConfig,
  seedPacksToStateDir,
  type ProductConfigRepairResult,
} from "./product-config-repair.js";
import type { ClaworksRuntime } from "./runtime-types.js";

export type DoctorCheck = {
  id: string;
  status: "ok" | "warn" | "error";
  message: string | null;
};

export function runClaworksDoctor(runtime: ClaworksRuntime): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  checks.push({
    id: "kernel",
    status: "ok",
    message: null,
  });

  const playbooks = runtime.playbookEngine.list();
  checks.push({
    id: "playbooks",
    status: playbooks.length > 0 ? "ok" : "warn",
    message:
      playbooks.length > 0
        ? null
        : "No playbooks loaded — check packs.paths and packs.installed in config",
  });

  const types = runtime.ontology.listTypes();
  checks.push({
    id: "ontology",
    status: types.length > 0 ? "ok" : "warn",
    message:
      types.length > 0 ? null : "No object types loaded — install process-industry or other packs",
  });

  checks.push({
    id: "packs",
    status: runtime.loadedPacks.length > 0 ? "ok" : "warn",
    message:
      runtime.loadedPacks.length > 0
        ? `Loaded: ${runtime.loadedPacks.map((p) => `${p.manifest.id}@${p.manifest.version}`).join(", ")}`
        : "No packs loaded",
  });

  try {
    runtime.db.prepare("SELECT 1").get();
    checks.push({ id: "database", status: "ok", message: null });
  } catch (err) {
    checks.push({
      id: "database",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const dbUrl = runtime.config.data?.database_url ?? "";
  if (dbUrl.startsWith("postgres")) {
    if (runtime.databaseNote) {
      checks.push({
        id: "database_postgres",
        status: "warn",
        message: runtime.databaseNote,
      });
    } else if (runtime.databaseDialect === "postgresql") {
      checks.push({
        id: "database_postgres",
        status: "ok",
        message: "PostgreSQL ObjectStore active (run `pnpm claworks:migrate` on fresh clusters)",
      });
    } else {
      checks.push({
        id: "database_postgres",
        status: "warn",
        message:
          "postgresql:// configured but dialect is not postgresql — check `pg` install and URL",
      });
    }
  }

  const kbProvider = runtime.config.data?.kb_provider ?? "stub";
  const kbEmbed = runtime.config.data?.kb_embed_model?.trim();
  checks.push({
    id: "kb",
    status: kbProvider === "memory-core" ? "ok" : "warn",
    message:
      kbProvider === "memory-core"
        ? `Vector KB via memory-core + memory-lancedb${kbEmbed ? ` (embed: ${kbEmbed})` : ""} — GET /v1/kb/status for live bridge`
        : "Using stub/file KB — set data.kb_provider=memory-core and run CLAWORKS_VECTOR_KB=1 pnpm claworks:repair",
  });

  const connectorIds = Object.keys(runtime.config.connectors ?? {}).filter(
    (id) =>
      (runtime.config.connectors as Record<string, { enabled?: boolean }>)[id]?.enabled !== false,
  );
  checks.push({
    id: "connectors",
    status: connectorIds.length > 0 ? "ok" : "warn",
    message:
      connectorIds.length > 0
        ? `Active: ${connectorIds.join(", ")}`
        : "No connectors enabled — set connectors.echo in config or CLAWORKS_DEMO_CONNECTORS=1 on init",
  });

  checks.push({
    id: "robot",
    status: "ok",
    message: `${runtime.robot.name} (${runtime.robot.role}) @ ${runtime.robot.endpoint}`,
  });

  if (!hasPackSourcesAvailable()) {
    checks.push({
      id: "packs_source",
      status: "warn",
      message: "No pack sources — clone ../claworks-packs or set CLAWORKS_PACKS_DIR",
    });
  }

  return checks;
}

export async function runClaworksDoctorFix(
  runtime: ClaworksRuntime,
): Promise<{ applied: string[]; warnings: string[]; repair: ProductConfigRepairResult }> {
  const applied: string[] = [];
  const warnings: string[] = [];

  const wrapped: Record<string, unknown> = {
    plugins: {
      allow: ["claworks-robot"],
      entries: {
        "claworks-robot": { enabled: true, config: runtime.config },
      },
    },
  };
  const sourceDir = discoverPackSourceDir();
  const pluginRepair = repairClaworksRobotPluginConfig(wrapped, {
    packSourceDir: sourceDir,
    enableEchoConnector: true,
  });
  if (pluginRepair.changed) {
    const repaired = (
      wrapped.plugins as { entries?: Record<string, { config?: typeof runtime.config }> }
    )?.entries?.["claworks-robot"]?.config;
    if (repaired) {
      runtime.config = repaired;
    }
    applied.push(...pluginRepair.actions);
  }
  warnings.push(...pluginRepair.warnings);

  const sourceDirForSeed = sourceDir;
  const seed = seedPacksToStateDir({
    sourceDir: sourceDirForSeed ?? undefined,
    packIds: runtime.config.packs?.installed ?? undefined,
  });
  if (seed.linked.length > 0) {
    applied.push(`Linked packs under ~/.claworks/packs: ${seed.linked.join(", ")}`);
  }
  warnings.push(...seed.warnings);

  const persisted = await loadPersistedInstalled();
  const packConfig = mergePackConfig(runtime.config.packs, persisted);
  const extraPaths = [sourceDir].filter((p): p is string => Boolean(p));
  packConfig.paths = [...new Set([...(packConfig.paths ?? []), ...extraPaths])];
  runtime.config.packs = packConfig;

  if (!runtime.config.connectors || Object.keys(runtime.config.connectors).length === 0) {
    runtime.config.connectors = { echo: { preset: "echo", enabled: true } };
    applied.push("connectors.echo: enabled");
  }

  await reloadClaworksPacksFromDisk(runtime);
  applied.push(
    `Reloaded ${runtime.loadedPacks.length} pack(s), ${runtime.playbookEngine.list().length} playbook(s), ${runtime.ontology.listTypes().length} object type(s)`,
  );

  return { applied, warnings, repair: { changed: applied.length > 0, actions: applied, warnings } };
}
