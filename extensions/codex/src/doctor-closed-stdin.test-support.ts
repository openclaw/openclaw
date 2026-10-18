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
const cfg: OpenClawConfig = JSON.parse(process.argv[3]);
const checks: HealthCheck[] = [];
registerCodexManagedAppServerDoctorChecks(
  {
    pluginRoot: path.dirname(command),
    getHealthCheck: () => undefined,
    registerHealthCheck: (check) => checks.push(check),
  },
  {
    resolveStartOptions: async (start) => ({
      ...start,
      command,
      commandSource: "resolved-managed",
    }),
    resolveNativeCommand: () => command,
  },
);
const result = await runDoctorLintChecks(
  { mode: "lint", runtime: createNonExitingRuntime(), cfg, env: process.env },
  { checks, onlyIds: ["codex/managed-app-server"] },
);
process.exitCode = exitCodeFromFindings(result.findings);
process.stdout.write(JSON.stringify({ ok: process.exitCode === 0, ...result }));
