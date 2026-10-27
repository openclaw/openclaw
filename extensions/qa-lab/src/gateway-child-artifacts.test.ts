import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { listDirectoryTreeStrict } from "openclaw/plugin-sdk/file-access-runtime";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import {
  openOpenClawAgentDatabase,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qaGatewayCleanupRuntimeEntrypoint } from "./gateway-child-artifacts-runtime.test-support.js";
import {
  cleanupQaGatewayTempRoots,
  preserveQaGatewayDebugArtifacts,
} from "./gateway-child-artifacts.js";
import { createQaGatewaySetupHarness } from "./gateway-child-setup.test-support.js";
import { resolveQaNodeExecPath } from "./node-exec.js";
import { readQaAuthProfiles, writeQaAuthProfiles } from "./providers/shared/auth-store.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";
import { runQaScenarioCommandLifecycle } from "./test-file-scenario-command-lifecycle.js";

const dirs = createTempDirHarness();
const setup = createQaGatewaySetupHarness();
const runtimeRoots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await setup.cleanup();
  for (const tempRoot of runtimeRoots.splice(0)) {
    await cleanupQaGatewayTempRoots({ tempRoot });
  }
  await dirs.cleanup();
});

describe("cleanupQaGatewayTempRoots", () => {
  it("removes child scratch and compiler caches without touching the parent temp directory", async () => {
    const parentTemp = await fs.realpath(await dirs.makeTempDir("qa-parent-temp-"));
    const inheritedTemp = { TMPDIR: parentTemp, TMP: parentTemp, TEMP: parentTemp };
    const { tempRoot, env, lifetime } = await setup.prepare(
      { runtimeEnvPatch: inheritedTemp },
      { ...inheritedTemp, NODE_DISABLE_COMPILE_CACHE: undefined, NODE_COMPILE_CACHE: undefined },
    );
    const result = await runQaScenarioCommandLifecycle({
      command: await resolveQaNodeExecPath(),
      args: [
        "--input-type=module",
        "-e",
        `
import fs from "node:fs";
import { enableCompileCache, flushCompileCache } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
// openclaw-temp-dir: allow verifies child scratch containment and cleanup
const scratch = fs.mkdtempSync(path.join(tmpdir(), "qa-child-"));
const source = path.join(scratch, "fixture.mjs");
fs.writeFileSync(source, "export const value = 42;\\n");
const cache = enableCompileCache(path.join(tmpdir(), "node-compile-cache"));
await import(pathToFileURL(source).href);
flushCompileCache();
console.log(JSON.stringify({ scratch, cache }));
`,
      ],
      cwd: tempRoot,
      env,
    });
    expect(result, result.failureMessage).toMatchObject({ exitCode: 0, stderr: "" });
    const { scratch, cache } = JSON.parse(result.stdout) as {
      scratch: string;
      cache: { directory: string };
    };
    expect(await fs.realpath(path.dirname(scratch))).toBe(tempRoot);
    expect(path.relative(tempRoot, await fs.realpath(cache.directory))).not.toMatch(/^\.\./u);
    const cacheEntries = (await listDirectoryTreeStrict(cache.directory)).map(
      (walkEntry) => walkEntry.dirent,
    );
    expect(cacheEntries.some((entry) => entry.isFile())).toBe(true);
    expect(await lifetime.stop()).toEqual({ process: "never-spawned", errors: [] });
    await expect(fs.stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(parentTemp)).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "does not inspect child-private state before startup or boundary cleanup",
    async () => {
      const tempRoot = await dirs.makeTempDir("qa-cleanup-private-state-");
      const stateDir = path.join(tempRoot, "state");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(databasePath, "child-owned state");
      // Reproduce the runner's filesystem boundary without privileged chown:
      // no parent handles exist, and traversal is denied after SUT auth staging.
      await fs.chmod(stateDir, 0);
      const cleanupTempRoot = vi.fn(async () => {
        await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "EACCES" });
        await fs.chmod(stateDir, 0o700);
        await fs.rm(tempRoot, { recursive: true, force: true });
      });
      try {
        await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "EACCES" });
        // prepareAttempt invokes this after the packaged auth subprocess exits.
        await closeQaRuntimeStores(tempRoot);
        await cleanupQaGatewayTempRoots({ tempRoot, cleanupTempRoot });
        expect(cleanupTempRoot).toHaveBeenCalledOnce();
        await expect(fs.stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.chmod(stateDir, 0o700).catch((error: unknown) => {
          if (extractErrorCode(error) !== "ENOENT") {
            throw error;
          }
        });
      }
    },
  );
  it("does not recreate disposed state at natural parent exit or close sibling stores", async () => {
    const root = await fs.realpath(await dirs.makeTempDir("qa-cleanup-parent-stores-"));
    const tempRoot = path.join(root, "runtime");
    const stagedBundledPluginsRoot = path.join(root, "plugins");
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    await Promise.all([home, tmp, stagedBundledPluginsRoot].map((dir) => fs.mkdir(dir)));
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const result = await runQaScenarioCommandLifecycle({
      command: process.execPath,
      args: [
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(qaGatewayCleanupRuntimeEntrypoint)),
        tempRoot,
        stagedBundledPluginsRoot,
      ],
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
        // Reserve stderr for errors; slow-open warnings depend on host load.
        OPENCLAW_LOG_LEVEL: "error",
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_STATE_HOME: path.join(home, "xdg-state"),
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        TSX_DISABLE_CACHE: "1",
        TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
      },
      timeoutMs: 90_000,
    });
    expect(result, result.failureMessage).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.failureMessage).toBeUndefined();
    // Check from outside the process: SQLite exit hooks run after cleanup returns.
    await expect(fs.stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(stagedBundledPluginsRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(result.stdout)).toEqual({ targetClosed: true, siblingUsable: true });
  }, 120_000);

  it.each([
    ["agent", "tempRoot: Agent database close failed"],
    ["shared", "tempRoot: close failed"],
  ] as const)(
    "retains runtime on %s close failure, removes staging, and permits cleanup retry",
    async (failedStore, expectedDiagnostic) => {
      const tempRoot = await dirs.makeTempDir("qa-cleanup-store-failure-");
      runtimeRoots.push(tempRoot);
      const stagedBundledPluginsRoot = await dirs.makeTempDir("qa-cleanup-store-plugins-");
      const stateDir = path.join(tempRoot, "state");
      const agentDir = path.join(stateDir, "agents", "qa", "agent");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeQaAuthProfiles({
        agentId: "qa",
        stateDir,
        profiles: { fake: { type: "api_key", provider: "openai", key: "qa-synthetic" } },
      });
      await readQaAuthProfiles(agentDir);
      const agent = openOpenClawAgentDatabase({
        agentId: "qa",
        env,
        path: path.join(agentDir, "openclaw-agent.sqlite"),
      });
      const shared = openOpenClawStateDatabase({ env });
      const failed = failedStore === "agent" ? agent : shared;
      const close = vi.spyOn(failed.db, "close").mockImplementationOnce(() => {
        throw new Error("close failed apiKey=synthetic-close-secret", {
          cause: new Error("synthetic-close-cause"),
        });
      });

      const outcome = await cleanupQaGatewayTempRoots({
        tempRoot,
        stagedBundledPluginsRoot,
      }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(AggregateError);
      expect(inspect(outcome, { depth: null })).toContain(expectedDiagnostic);
      expect(inspect(outcome, { depth: null })).not.toMatch(
        /synthetic-close-secret|synthetic-close-cause/,
      );
      expect(failed.db.isOpen).toBe(true);
      expect(shared.db.isOpen).toBe(true);
      await expect(fs.stat(tempRoot)).resolves.toBeDefined();
      await expect(fs.stat(stagedBundledPluginsRoot)).rejects.toMatchObject({ code: "ENOENT" });

      close.mockRestore();
      await cleanupQaGatewayTempRoots({ tempRoot, stagedBundledPluginsRoot });
      expect(agent.db.isOpen).toBe(false);
      expect(shared.db.isOpen).toBe(false);
      await expect(fs.stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  // Short messages expose cause leaks that padding could hide behind truncation.
  it.each([
    { failedRoots: ["tempRoot"], padding: "" },
    { failedRoots: ["stagedBundledPluginsRoot"], padding: "" },
    { failedRoots: ["tempRoot", "stagedBundledPluginsRoot"], padding: "diagnostic ".repeat(400) },
  ])(
    "reports $failedRoots failures after attempting both roots",
    async ({ failedRoots, padding }) => {
      const roots = {
        tempRoot: await dirs.makeTempDir("qa-cleanup-runtime-"),
        stagedBundledPluginsRoot: await dirs.makeTempDir("qa-cleanup-plugins-"),
      };
      const originalRm = fs.rm;
      const attempts: string[] = [];
      vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        const entry = Object.entries(roots).find(([, root]) => root === target);
        if (entry) {
          attempts.push(entry[0]);
          if (failedRoots.includes(entry[0])) {
            throw Object.assign(
              new Error(`EACCES: denied apiKey=synthetic-cleanup-secret\n${padding}`),
              { code: "EACCES", path: target, cause: new Error("synthetic-raw-cause") },
            );
          }
        }
        return originalRm(target, options);
      });

      const outcome = await cleanupQaGatewayTempRoots(roots).catch((error: unknown) => error);
      expect(attempts).toEqual(Object.keys(roots));
      for (const [label, root] of Object.entries(roots)) {
        if (failedRoots.includes(label)) {
          await expect(fs.stat(root)).resolves.toBeDefined();
        } else {
          await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      expect(outcome).toBeInstanceOf(AggregateError);
      if (!(outcome instanceof AggregateError)) {
        throw new Error("expected cleanup failure");
      }
      expect(outcome.errors).toHaveLength(failedRoots.length);
      for (const label of failedRoots) {
        expect(outcome.message).toContain(label);
      }
      expect(outcome.message).toContain("EACCES");
      expect(outcome.message.length).toBeLessThan(4_500);
      expect(inspect(outcome, { depth: null })).not.toMatch(
        /synthetic-cleanup-secret|synthetic-raw-cause/,
      );
    },
  );

  it.each([undefined, null, "missing"])(
    "accepts an already removed runtime with staged root %s",
    async (staging) => {
      const parent = await dirs.makeTempDir("qa-cleanup-absent-");
      await expect(
        cleanupQaGatewayTempRoots({
          tempRoot: path.join(parent, "runtime"),
          stagedBundledPluginsRoot: staging ? path.join(parent, staging) : staging,
        }),
      ).resolves.toBeUndefined();
    },
  );
});

describe("preserveQaGatewayDebugArtifacts", () => {
  it("preserves only sanitized gateway debug artifacts", async () => {
    const tempRoot = await dirs.makeTempDir("qa-gateway-preserve-src-");
    const repoRoot = await dirs.makeTempDir("qa-gateway-preserve-repo-");

    const stdoutLogPath = path.join(tempRoot, "gateway.stdout.log");
    const stderrLogPath = path.join(tempRoot, "gateway.stderr.log");
    const artifactDir = path.join(repoRoot, ".artifacts", "qa-e2e", "gateway-runtime");
    await fs.mkdir(path.dirname(artifactDir), { recursive: true });
    await fs.writeFile(
      stdoutLogPath,
      [
        "OPENCLAW_GATEWAY_TOKEN=qa-suite-token",
        'OPENAI_API_KEY="openai-live"',
        "OPENROUTER_API_KEY=openrouter-live",
        'CUSTOM_API_KEYS="custom-a,custom-b"',
        "CUSTOM_API_KEY_2=custom-b",
        "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN=qa-token",
        "OPENCLAW_LIVE_SETUP_TOKEN_VALUE=qa-token-alias",
        "OPENCLAW_QA_CONVEX_SECRET_CI=convex-ci-secret",
        "OPENCLAW_QA_CONVEX_SECRET_MAINTAINER=convex-maintainer-secret",
        "OPENCLAW_LIVE_CODEX_API_KEY=codex-live-secret",
        "botToken=12345:AbCdEfGhIjKl",
        "--botToken=12345:flag-secret",
        '"driverToken":"12345:driver-secr3t"',
        "sutToken='12345:sut-secr3t'",
        "leaseToken=lease-12345",
        '"apiKey":"secret-json-api-key"',
        "clientSecret=secret-client-secret&secret-tail",
        "url=http://127.0.0.1:18789/#token=abc123",
        "callback=https://gateway.example.test/callback?access_token=secret-access-token&ok=1",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      stderrLogPath,
      [
        "Authorization: Bearer secret+/token=123456",
        "Cookie: qa_session=secret-cookie; theme=dark",
        "Set-Cookie: qa_session=secret-cookie; HttpOnly",
        "x-api-key: secret-header-api-key",
      ].join("\n"),
      "utf8",
    );
    await fs.mkdir(path.join(tempRoot, "state"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "state", "secret.txt"), "do-not-copy", "utf8");

    await preserveQaGatewayDebugArtifacts({
      preserveToDir: artifactDir,
      stdoutLogPath,
      stderrLogPath,
      tempRoot,
      repoRoot,
    });

    expect((await fs.readdir(artifactDir)).toSorted()).toEqual([
      "README.txt",
      "gateway.stderr.log",
      "gateway.stdout.log",
    ]);
    await expect(fs.readFile(path.join(artifactDir, "gateway.stdout.log"), "utf8")).resolves.toBe(
      [
        "OPENCLAW_GATEWAY_TOKEN=<redacted>",
        "OPENAI_API_KEY=<redacted>",
        "OPENROUTER_API_KEY=<redacted>",
        "CUSTOM_API_KEYS=<redacted>",
        "CUSTOM_API_KEY_2=<redacted>",
        "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN=<redacted>",
        "OPENCLAW_LIVE_SETUP_TOKEN_VALUE=<redacted>",
        "OPENCLAW_QA_CONVEX_SECRET_CI=<redacted>",
        "OPENCLAW_QA_CONVEX_SECRET_MAINTAINER=<redacted>",
        "OPENCLAW_LIVE_CODEX_API_KEY=<redacted>",
        "botToken=<redacted>",
        "--botToken=<redacted>",
        '"driverToken":"<redacted>"',
        "sutToken=<redacted>",
        "leaseToken=<redacted>",
        '"apiKey":"<redacted>"',
        "clientSecret=<redacted>",
        "url=http://127.0.0.1:18789/#token=<redacted>",
        "callback=https://gateway.example.test/callback?access_token=<redacted>&ok=1",
      ].join("\n"),
    );
    await expect(fs.readFile(path.join(artifactDir, "gateway.stderr.log"), "utf8")).resolves.toBe(
      [
        "Authorization: Bearer <redacted>",
        "Cookie: <redacted>",
        "Set-Cookie: <redacted>",
        "x-api-key: <redacted>",
      ].join("\n"),
    );
    await expect(fs.readFile(path.join(artifactDir, "README.txt"), "utf8")).resolves.toContain(
      "was not copied because it may contain credentials or auth tokens",
    );
    await expect(fs.readFile(path.join(artifactDir, "README.txt"), "utf8")).resolves.not.toContain(
      tempRoot,
    );
  });
});
