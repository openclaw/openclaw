import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCrabboxNodeEnrollmentSetup,
  type CrabboxWorkerNodeEnrollment,
} from "./crabbox-worker-node-enrollment.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const leaseId = "cbx_codex_test";
const workerCodex = {
  configToml:
    'model = "codex-test-model"\n[model_providers.fixture.auth]\ncommand = "node"\nargs = ["/gateway/token.mjs"]\n',
  helperScript: 'process.stdout.write("synthetic-worker-inference-token")\n',
  helperPath: "/gateway/token.mjs",
  configVersion: "a".repeat(64),
};

async function enroll(home: string, settings = workerCodex) {
  const setup = createCrabboxNodeEnrollmentSetup({
    leaseId,
    enrollment: {
      mode: "resume",
      deviceId: "fixture-node",
      openclawVersion: "2026.8.1",
      displayName: "Codex enrollment fixture",
      nodeBootstrap: createNodeBootstrapFixture({ enabledPluginIds: [] }),
      waitForDeviceId: async () => "fixture-node",
      workerCodex: settings,
    } satisfies CrabboxWorkerNodeEnrollment,
  });
  expect(setup.command).not.toContain(settings.helperScript);
  expect(setup.command).not.toContain(Buffer.from(JSON.stringify(settings)).toString("base64"));
  const script = setup.command
    .split("CRABBOX_NODE_ENROLLMENT_SCRIPT'\n")[1]!
    .split("\nCRABBOX_NODE_ENROLLMENT_SCRIPT")[0]!;
  const child = spawn(process.execPath, ["-e", script], {
    env: { HOME: home, PATH: process.env.PATH, ...setup.forwardedEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
  const [code] = await once(child, "close");
  return { code, output: Buffer.concat(output).toString("utf8") };
}

describe.skipIf(process.platform !== "linux")("private Codex node enrollment", () => {
  it("stages before launch, strips transport env, and rejects changed version or contents on replay", async () => {
    const home = fs.realpathSync(tempDirs.make("crabbox-codex-enrollment-"));
    const stateDir = path.join(home, ".openclaw", "cloud-workers", leaseId);
    // A verified prepared runtime is an independent external CLI fixture; enrollment is unchanged.
    const runtime = path.join(
      home,
      ".openclaw-worker",
      "node-runtimes",
      "a".repeat(64),
      "node_modules",
      "openclaw",
    );
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(
      path.join(runtime, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.8.1" }),
    );
    fs.writeFileSync(
      path.join(runtime, "openclaw.mjs"),
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'if (process.argv[2] === "--version") console.log("OpenClaw 2026.8.1");',
        "else {",
        "const state = process.env.OPENCLAW_STATE_DIR;",
        'const version = path.join(state, "codex-runtime", "version");',
        'fs.writeFileSync(path.join(state, "observed.json"), JSON.stringify({',
        'version: fs.existsSync(version) ? fs.readFileSync(version, "utf8") : undefined,',
        "transported: process.env.CRABBOX_WORKER_CODEX_CONFIG,",
        "bootstrapToken: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN,",
        "}));",
        "setInterval(() => {}, 60_000);",
        "}",
      ].join("\n"),
    );
    try {
      const result = await enroll(home);
      expect(result.code, result.output).toBe(0);
      expect(result.output).not.toContain("synthetic-");
      const observed = path.join(stateDir, "observed.json");
      await vi.waitFor(() => expect(fs.existsSync(observed)).toBe(true));
      expect(JSON.parse(fs.readFileSync(observed, "utf8"))).toEqual({
        version: workerCodex.configVersion,
      });
      const directory = path.join(stateDir, "codex-runtime");
      const helper = path.join(directory, "token.mjs");
      expect(fs.readFileSync(path.join(directory, "config.toml"), "utf8")).toBe(
        workerCodex.configToml.replace(workerCodex.helperPath, helper),
      );
      expect(fs.readFileSync(helper, "utf8")).toBe(workerCodex.helperScript);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      for (const name of ["config.toml", "token.mjs", "version"]) {
        expect(fs.statSync(path.join(directory, name)).mode & 0o777).toBe(0o600);
      }
      const pid = fs.readFileSync(path.join(stateDir, "node.pid"), "utf8");
      expect(await enroll(home)).toMatchObject({ code: 0 });
      for (const change of [
        { configVersion: "b".repeat(64) },
        { helperScript: 'process.stdout.write("synthetic-replacement-token")\n' },
      ]) {
        const rejected = await enroll(home, { ...workerCodex, ...change });
        expect(rejected).toMatchObject({
          code: 1,
          output: expect.stringContaining("Codex version changed on an existing lease"),
        });
        expect(rejected.output).not.toContain("synthetic-");
        expect(fs.readFileSync(path.join(directory, "version"), "utf8")).toBe(
          workerCodex.configVersion,
        );
        expect(fs.readFileSync(helper, "utf8")).toBe(workerCodex.helperScript);
        expect(fs.readFileSync(path.join(stateDir, "node.pid"), "utf8")).toBe(pid);
      }
    } finally {
      const pidFile = path.join(stateDir, "node.pid");
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        process.kill(-pid, "SIGTERM");
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow("ESRCH"));
      }
    }
  });
});
