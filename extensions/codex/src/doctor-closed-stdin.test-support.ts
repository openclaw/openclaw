import path from "node:path";
import {
  exitCodeFromFindings,
  runDoctorLintChecks,
  type HealthCheck,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/health";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { registerCodexManagedAppServerDoctorChecks } from "./doctor.js";

const command = process.argv[2];
const configJson = process.argv[3];
if (!command || !configJson) {
  throw new Error("Missing Codex fixture command or config");
}
const cfg: OpenClawConfig = JSON.parse(configJson);
const checks: HealthCheck[] = [];
registerCodexManagedAppServerDoctorChecks({
  pluginRoot: path.dirname(command),
  getHealthCheck: () => undefined,
  registerHealthCheck: (check) => checks.push(check),
});
const result = await runDoctorLintChecks(
  { mode: "lint", runtime: createNonExitingRuntime(), cfg, env: process.env },
  { checks, onlyIds: ["codex/managed-app-server"] },
);
process.exitCode = exitCodeFromFindings(result.findings);
process.stdout.write(JSON.stringify({ ok: process.exitCode === 0, ...result }));
