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
    checks.push({
      id: "database_postgres",
      status: "warn",
      message:
        "postgresql:// configured: run `pnpm claworks:migrate` for schema; runtime ObjectStore uses SQLite cache until PG adapter is enabled",
    });
  }

  checks.push({
    id: "robot",
    status: "ok",
    message: `${runtime.robot.name} (${runtime.robot.role}) @ ${runtime.robot.endpoint}`,
  });

  return checks;
}
