import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { mcpImportRuntimeEntrypoints } from "./mcp-import-runtime.test-support.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureUrl = resolveRuntimeWorkerUrl(mcpImportRuntimeEntrypoints.authProfile);
const nodeExecutable = resolveTestNodeExecPath();

function createChildEnv(root: string): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const temporary = path.join(root, "tmp");
  for (const dir of [home, state, temporary]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const configPath = path.join(state, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n");
  // A fresh process must not inherit operator credentials, test mocks, or Node preloads.
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  };
}

describe("MCP profile auth through real credential owners", () => {
  it.each([
    ["external", "stays cold until demand and observes external rotation, removal, and origins"],
    ["refresh", "refreshes persisted OAuth through the SDK and projects only raw access tokens"],
    ["scopes", "retains request bindings and exact plugin generations across deferred auth"],
  ])(
    "%s: %s",
    async (scenario) => {
      const root = tempDirs.make("openclaw-mcp-auth-demand-");
      // Child isolation also keeps neighboring suites' store/provider mocks out of this proof.
      const { stdout } = await execFileAsync(
        nodeExecutable,
        [...resolveRuntimeWorkerArgv(fixtureUrl, nodeExecutable), scenario, root],
        {
          cwd: repoRoot,
          env: createChildEnv(root),
          timeout: 30_000,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
        },
      );
      expect(stdout).toContain(`MCP_AUTH_PROOF_OK ${scenario}`);
    },
    40_000,
  );
});
