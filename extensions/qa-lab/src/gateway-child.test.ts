import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preserveQaGatewayDebugArtifacts } from "./gateway-child-artifacts.js";
import { runQaGatewayCliCommand } from "./gateway-child-command.js";
import {
  readJsonLines,
  registerSourceGatewayHostLifelineTest,
  writePackagedGatewayFixture,
} from "./gateway-child-command.test-support.js";
import {
  buildQaForcedRuntimeEnvPatch,
  buildQaRuntimeEnv,
  stageQaCodexMockModelCatalog,
} from "./gateway-child-env.js";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import {
  closeQaGatewayLogStream,
  createQaGatewayChildLogAccess,
  createQaGatewayChildLogCollector,
  formatQaGatewayProcessBoundaryStartupFailure,
  monitorQaGatewayChildFailure,
  stopQaGatewayChildProcessTree,
  throwQaGatewayChildFailure,
} from "./gateway-child-process.js";
import {
  needsQaGatewayMigrationRestart,
  waitForGatewayReady,
  waitForQaGatewayRestartBoundary,
} from "./gateway-child-readiness.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const qaTempPathState = vi.hoisted(() => ({
  preferredTmpDir: process.env.TMPDIR || "/tmp",
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => qaTempPathState.preferredTmpDir,
}));

const tempDirs = createTempDirHarness();
const owners: ReturnType<typeof createQaGatewayChild>[] = [];
beforeEach(() => {
  vi.stubEnv("OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_LIVE_SETUP_TOKEN_VALUE", undefined);
});
function ownGateway() {
  const owner = createQaGatewayChild();
  owners.push(owner);
  return owner;
}

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
  qaTempPathState.preferredTmpDir = process.env.TMPDIR || "/tmp";
  for (const owner of owners.splice(0)) {
    await owner.stop();
  }
  await tempDirs.cleanup();
});

async function createPackagedFixture(
  runtimeEnvPatch: NodeJS.ProcessEnv,
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig,
) {
  const fixtureRoot = await tempDirs.makeTempDir("qa-packaged-");
  const tempParentDir = path.join(fixtureRoot, "gateway-temp");
  const recordPath = path.join(fixtureRoot, "commands.jsonl");
  const fixturePath = await writePackagedGatewayFixture(fixtureRoot);
  await mkdir(tempParentDir);
  const owner = ownGateway();
  return {
    owner,
    tempParentDir,
    recordPath,
    start: () =>
      owner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: [fixturePath],
          tempParentDir,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        transportBaseUrl: "http://127.0.0.1:43123",
        runtimeEnvPatch: { QA_RECORD_PATH: recordPath, ...runtimeEnvPatch },
        mutateConfig,
      }),
  };
}

function createParams(baseEnv?: NodeJS.ProcessEnv) {
  return {
    configPath: "/tmp/openclaw-qa/openclaw.json",
    gatewayToken: "qa-token",
    homeDir: "/tmp/openclaw-qa/home",
    stateDir: "/tmp/openclaw-qa/state",
    tempRoot: "/tmp/openclaw-qa",
    xdgConfigHome: "/tmp/openclaw-qa/xdg-config",
    xdgDataHome: "/tmp/openclaw-qa/xdg-data",
    xdgCacheHome: "/tmp/openclaw-qa/xdg-cache",
    bundledPluginsDir: "/tmp/openclaw-qa/bundled-plugins",
    stagedBundledPluginsRoot: "/repo/.artifacts/qa-runtime/openclaw-qa-suite-test",
    compatibilityHostVersion: "2026.4.8",
    developmentSourceRoot: "/repo/openclaw",
    baseEnv,
  };
}

type SsrFetchCall = {
  url: string;
  init?: RequestInit;
  policy?: unknown;
  auditContext?: string;
};

function requireSsrFetchCall(index = 0): SsrFetchCall {
  const call = fetchWithSsrFGuardMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected SSRF fetch call ${index}`);
  }
  return call[0] as SsrFetchCall;
}

describe("runQaGatewayCliCommand", () => {
  it("retains bounded redacted stdout failures alongside stderr panels", async () => {
    const lifetime = new QaGatewayChildLifecycle();
    try {
      const error = await runQaGatewayCliCommand({
        lifetime,
        executablePath: process.execPath,
        argsPrefix: [
          "--input-type=module",
          "--eval",
          `await new Promise((resolve) => process.stderr.write(
            "Doctor panel: Authorization: Bearer fixture-panel-secret\\n" + "diagnostic ".repeat(400), resolve));
          await new Promise((resolve) => process.stdout.write(JSON.stringify({
            status: "error", reason: "readiness execution failed", apiKey: "fixture-result-secret",
          }), resolve));
          process.exit(7);`,
        ],
        args: [],
        cwd: process.cwd(),
        env: process.env,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw new Error("expected CLI failure");
      }
      expect(error.message).toContain("OpenClaw CLI exited 7: Doctor panel:");
      expect(error.message).toContain('"reason":"readiness execution failed"');
      expect(error.message.length).toBeLessThanOrEqual(2_048);
      expect(error.message).toContain("Bearer <redacted>");
      expect(error.message).toContain('"apiKey":"<redacted>"');
      expect(inspect(error, { depth: null })).not.toMatch(/fixture-(panel|result)-secret/u);
    } finally {
      await expect(lifetime.stop()).resolves.toEqual({ process: "confirmed-stopped", errors: [] });
    }
  });
});

describe("monitorQaGatewayChildFailure", () => {
  it("records the first pipe failure and stops the detached Gateway child", async () => {
    const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const close = once(child, "close");
    const output = createQaGatewayChildLogCollector();
    const getFailure = monitorQaGatewayChildFailure(child, output);
    const error = new Error("synthetic gateway stdout read failure");

    child.stdout?.destroy(error);
    child.stderr?.destroy(new Error("later stderr read failure"));

    await vi.waitFor(() => expect(getFailure()).toEqual({ source: "stdout", error }));
    await close;
    expect(output.text()).toContain(
      "gateway child stdout stream failed: synthetic gateway stdout read failure",
    );
    expect(output.text()).not.toContain("later stderr read failure");
    expect(() => throwQaGatewayChildFailure(getFailure, () => output.text())).toThrow(
      "gateway child stdout stream failed: synthetic gateway stdout read failure",
    );
  });
});

describe("formatQaGatewayProcessBoundaryStartupFailure", () => {
  it("includes only a bounded, redacted launcher log tail", () => {
    const prefix = "x".repeat(9_000);
    const longSecret = "s".repeat(9_000);
    const message = formatQaGatewayProcessBoundaryStartupFailure(
      new Error("launcher exited before identity"),
      `${prefix}\nAuthorization: Bearer ${longSecret}\nlauncher stage=mount-proc`,
    );

    expect(message).toContain("launcher exited before identity");
    expect(message).toContain("Gateway logs:");
    expect(message).toContain("Authorization: Bearer <redacted>");
    expect(message).toContain("launcher stage=mount-proc");
    expect(message).not.toContain("s".repeat(100));
    expect(message).not.toContain(prefix);
  });
});

describe("waitForGatewayReady", () => {
  it("does not accept a healthy listener as readiness", async () => {
    vi.useFakeTimers();
    const baseUrl = "http://127.0.0.1:43124";
    const release = vi.fn(async () => {});
    let ready = false;

    fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
      const status = url.endsWith("/healthz") || ready ? 200 : 503;
      return { response: { ok: status === 200, status }, release };
    });

    try {
      const readiness = waitForGatewayReady({
        baseUrl,
        logs: () => "startup logs",
        child: { exitCode: null, signalCode: null },
        timeoutMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(fetchWithSsrFGuardMock.mock.calls.map(([request]) => request.url)).toEqual([
        `${baseUrl}/readyz`,
      ]);
      const healthRequest = requireSsrFetchCall();
      expect(healthRequest.init?.method).toBe("HEAD");
      expect(healthRequest.init?.headers).toEqual({ connection: "close" });
      expect(healthRequest.policy).toEqual({ allowPrivateNetwork: true });
      expect(healthRequest.auditContext).toBe("qa-lab-gateway-child-health");
      expect(release).toHaveBeenCalledTimes(1);

      ready = true;
      await vi.advanceTimersByTimeAsync(250);

      await expect(readiness).resolves.toBeUndefined();
      expect(fetchWithSsrFGuardMock.mock.calls.map(([request]) => request.url)).toEqual([
        `${baseUrl}/readyz`,
        `${baseUrl}/readyz`,
      ]);
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled readiness probe by the remaining deadline", async () => {
    let probeSignal: AbortSignal | undefined;
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ init }: { init?: RequestInit }) =>
        await new Promise((_, reject) => {
          probeSignal = init?.signal ?? undefined;
          probeSignal?.addEventListener(
            "abort",
            () => reject(toErrorObject(probeSignal?.reason, "QA readiness probe aborted")),
            { once: true },
          );
        }),
    );
    const startedAt = Date.now();

    await expect(
      waitForGatewayReady({
        baseUrl: "http://127.0.0.1:43124",
        logs: () => "near-expiry logs",
        child: { exitCode: null, signalCode: null },
        timeoutMs: 25,
      }),
    ).rejects.toThrow("gateway failed to become healthy");

    expect(probeSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("Gateway child fixture helpers", () => {
  it("stages native Codex model metadata before starting the private mock runtime", async () => {
    const tempRoot = await tempDirs.makeTempDir("qa-codex-model-catalog-");
    const modelCatalogPath = await stageQaCodexMockModelCatalog({
      tempRoot,
      forcedRuntime: "codex",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      autoCompactTokenLimit: 1,
    });

    expect(modelCatalogPath).toBe(path.join(tempRoot, "codex-model-catalog.json"));
    const catalog = JSON.parse(await readFile(modelCatalogPath!, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    expect(catalog.models).toEqual([
      expect.objectContaining({
        slug: "gpt-5.6-luna",
        auto_compact_token_limit: 1,
        apply_patch_tool_type: "freeform",
        supports_reasoning_summary_parameter: true,
        tool_mode: "direct",
      }),
      expect.objectContaining({
        slug: "gpt-5.6-luna-alt",
        auto_compact_token_limit: 1,
        apply_patch_tool_type: "freeform",
        supports_reasoning_summary_parameter: true,
        tool_mode: "direct",
      }),
    ]);
    expect(catalog.models[0]).not.toHaveProperty("supports_reasoning_summaries");
    const runtimeEnvPatch = buildQaForcedRuntimeEnvPatch({
      forcedRuntime: "codex",
      providerMode: "mock-openai",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      codexModelCatalogPath: modelCatalogPath,
    });
    expect(runtimeEnvPatch).toEqual(
      expect.objectContaining({
        OPENCLAW_CODEX_APP_SERVER_ARGS: `app-server -c openai_base_url=http://127.0.0.1:44080/v1 -c ${JSON.stringify(`model_catalog_json=${modelCatalogPath}`)} -c sandbox_workspace_write.exclude_tmpdir_env_var=true -c sandbox_workspace_write.exclude_slash_tmp=true --listen stdio://`,
      }),
    );
    expect(runtimeEnvPatch).not.toHaveProperty("OPENAI_API_KEY");
    expect(runtimeEnvPatch).not.toHaveProperty("CODEX_API_KEY");
  });

  it("does not stage a Codex catalog for other runtimes or live providers", async () => {
    const tempRoot = await tempDirs.makeTempDir("qa-codex-model-catalog-unused-");
    await expect(
      stageQaCodexMockModelCatalog({
        tempRoot,
        forcedRuntime: "openclaw",
        providerMode: "mock-openai",
      }),
    ).resolves.toBeUndefined();
    await expect(
      stageQaCodexMockModelCatalog({
        tempRoot,
        forcedRuntime: "codex",
        providerMode: "live-frontier",
      }),
    ).resolves.toBeUndefined();
    await expect(
      readFile(path.join(tempRoot, "codex-model-catalog.json"), "utf8"),
    ).rejects.toThrow();
  });
});

describe("buildQaRuntimeEnv", () => {
  it("cleans up temp QA gateway roots when repo CLI discovery fails before startup", async () => {
    const tempParent = await tempDirs.makeTempDir("qa-gateway-cli-discovery-fail-");
    const emptyRepo = await tempDirs.makeTempDir("qa-gateway-empty-repo-");
    qaTempPathState.preferredTmpDir = tempParent;

    const owner = ownGateway();
    await expect(
      owner.start({
        repoRoot: emptyRepo,
        useRepoCli: true,
        transportBaseUrl: "http://127.0.0.1:43123",
      }),
    ).rejects.toThrow("OpenClaw CLI entry not found");
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

    await expect(readdir(tempParent)).resolves.toStrictEqual([]);
  });

  it.each([
    {
      failure: "bundled plugin staging cannot copy root package metadata",
      packageContents: undefined,
      expectedError: /ENOENT/u,
    },
    {
      failure: "host version resolution cannot parse staged package metadata",
      packageContents: "{",
      expectedError: /JSON/u,
    },
  ])("cleans staged QA runtime roots when $failure", async ({ packageContents, expectedError }) => {
    const tempParent = await tempDirs.makeTempDir("qa-gateway-staged-runtime-fail-");
    const repoRoot = await tempDirs.makeTempDir("qa-gateway-staged-runtime-repo-");
    const stagedRuntimeParent = path.join(repoRoot, ".artifacts", "qa-runtime");
    qaTempPathState.preferredTmpDir = tempParent;

    if (packageContents !== undefined) {
      await writeFile(path.join(repoRoot, "package.json"), packageContents, "utf8");
    }

    const owner = ownGateway();
    await expect(
      owner.start({
        repoRoot,
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({}),
        },
        transportBaseUrl: "http://127.0.0.1:43123",
      }),
    ).rejects.toThrow(expectedError);
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

    await expect(readdir(tempParent)).resolves.toStrictEqual([]);
    await expect(readdir(stagedRuntimeParent)).resolves.toStrictEqual([]);
  });

  it("reports command spawn errors instead of leaking unhandled child errors", async () => {
    const preferredTempParent = await tempDirs.makeTempDir("qa-gateway-default-spawn-fail-");
    const commandTempParent = await tempDirs.makeTempDir("qa-gateway-command-spawn-fail-");
    qaTempPathState.preferredTmpDir = preferredTempParent;
    const missingExecutable = path.join(commandTempParent, "missing-openclaw-node");

    const owner = ownGateway();
    await expect(
      owner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: missingExecutable,
          tempParentDir: commandTempParent,
          usePackagedPlugins: true,
        },
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({}),
        },
        transportBaseUrl: "http://127.0.0.1:43123",
      }),
    ).rejects.toThrow(/installed package mock auth bootstrap failed for openai: .*ENOENT/u);
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

    await expect(readdir(preferredTempParent)).resolves.toStrictEqual([]);
    await expect(readdir(commandTempParent)).resolves.toStrictEqual([]);
  });

  it("isolates gateway children from Vitest without removing QA controls or non-test NODE_ENV", () => {
    const testEnv = buildQaRuntimeEnv({
      ...createParams({
        NODE_ENV: "test",
        VITEST: "true",
        VITEST_POOL_ID: "base-pool",
        VITEST_WORKER_ID: "base-worker",
      }),
      runtimeEnvPatch: {
        VITEST: "patched",
        VITEST_POOL_ID: "patched-pool",
        VITEST_WORKER_ID: "patched-worker",
      },
    });

    expect(testEnv.NODE_ENV).toBeUndefined();
    expect(testEnv.VITEST).toBeUndefined();
    expect(testEnv.VITEST_POOL_ID).toBeUndefined();
    expect(testEnv.VITEST_WORKER_ID).toBeUndefined();
    expect(testEnv.OPENCLAW_TEST_FAST).toBe("1");
    expect(testEnv.OPENCLAW_ALLOW_SLOW_REPLY_TESTS).toBe("1");

    const developmentEnv = buildQaRuntimeEnv({ ...createParams({ NODE_ENV: "development" }) });
    expect(developmentEnv.NODE_ENV).toBe("development");
  });

  it("does not inherit parent channel or provider skip controls", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
      }),
    });

    expect(env.OPENCLAW_SKIP_CHANNELS).toBeUndefined();
    expect(env.OPENCLAW_SKIP_PROVIDERS).toBeUndefined();
  });

  it("honors explicit channel and provider skip controls", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENCLAW_SKIP_CHANNELS: "inherited",
        OPENCLAW_SKIP_PROVIDERS: "inherited",
      }),
      runtimeEnvPatch: {
        OPENCLAW_SKIP_CHANNELS: "patched-channels",
        OPENCLAW_SKIP_PROVIDERS: "patched-providers",
      },
    });

    expect(env.OPENCLAW_SKIP_CHANNELS).toBe("patched-channels");
    expect(env.OPENCLAW_SKIP_PROVIDERS).toBe("patched-providers");
  });

  it("maps live key aliases without replacing explicit provider keys", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENCLAW_LIVE_OPENAI_KEY: "openai-live",
        OPENAI_API_KEY: "openai-explicit",
        OPENCLAW_LIVE_ANTHROPIC_KEY: "anthropic-live",
        OPENCLAW_LIVE_GEMINI_KEY: "gemini-live",
      }),
      providerMode: "live-frontier",
    });

    expect(env.OPENAI_API_KEY).toBe("openai-explicit");
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-live");
    expect(env.GEMINI_API_KEY).toBe("gemini-live");
  });

  it("preserves Codex CLI auth home for live frontier runs while sandboxing OpenClaw home", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");
    const codexHome = path.join(hostHome, ".codex");
    await mkdir(codexHome);

    const env = buildQaRuntimeEnv({
      ...createParams({
        HOME: hostHome,
      }),
      providerMode: "live-frontier",
    });

    expect(env.HOME).toBe("/tmp/openclaw-qa/home");
    expect(env.OPENCLAW_HOME).toBe("/tmp/openclaw-qa/home");
    expect(env.CODEX_HOME).toBe(codexHome);
  });

  it("forwards host HOME for live Claude CLI runs while keeping OpenClaw home sandboxed", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");

    const env = buildQaRuntimeEnv({
      ...createParams({
        HOME: hostHome,
      }),
      providerMode: "live-frontier",
      forwardHostHomeForClaudeCli: true,
    });

    expect(env.HOME).toBe(hostHome);
    expect(env.OPENCLAW_HOME).toBe("/tmp/openclaw-qa/home");
    expect(env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-qa/state");
  });

  it("can forward host HOME for browser-backed QA runs while keeping OpenClaw home sandboxed", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");

    const env = buildQaRuntimeEnv({
      ...createParams({
        HOME: hostHome,
      }),
      providerMode: "mock-openai",
      forwardHostHome: true,
    });

    expect(env.HOME).toBe(hostHome);
    expect(env.OPENCLAW_HOME).toBe("/tmp/openclaw-qa/home");
    expect(env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-qa/state");
  });

  it("preserves the live Anthropic key for live Claude CLI runs without writing it into config", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");

    const env = buildQaRuntimeEnv({
      ...createParams({
        HOME: hostHome,
        OPENCLAW_LIVE_ANTHROPIC_KEY: "anthropic-live",
        OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV: '["SAFE_KEEP"]',
      }),
      providerMode: "live-frontier",
      forwardHostHomeForClaudeCli: true,
      claudeCliAuthMode: "api-key",
    });

    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-live");
    expect(env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV).toBe('["SAFE_KEEP","ANTHROPIC_API_KEY"]');
    expect(env.OPENCLAW_LIVE_CLI_BACKEND_AUTH_MODE).toBe("api-key");
  });

  it("removes preserved Anthropic keys for live Claude CLI subscription runs", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");

    const env = buildQaRuntimeEnv({
      ...createParams({
        HOME: hostHome,
        ANTHROPIC_API_KEY: "anthropic-live",
        OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV: '["SAFE_KEEP","ANTHROPIC_API_KEY"]',
      }),
      providerMode: "live-frontier",
      forwardHostHomeForClaudeCli: true,
      claudeCliAuthMode: "subscription",
    });

    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-live");
    expect(env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV).toBe('["SAFE_KEEP"]');
    expect(env.OPENCLAW_LIVE_CLI_BACKEND_AUTH_MODE).toBe("subscription");
  });

  it.runIf(process.platform === "linux")(
    "scrubs inherited shell startup env before the workflow allowlist runs",
    async () => {
      const tempRoot = await tempDirs.makeTempDir("qa-shell-startup-env-");
      const markerPath = path.join(tempRoot, "bash-env-ran");
      const functionMarkerPath = path.join(tempRoot, "bash-function-ran");
      const bashEnvPath = path.join(tempRoot, "malicious-bash-env");
      const allowlistProbePath = path.join(tempRoot, "allowlist-probe.sh");
      await writeFile(bashEnvPath, `printf 'ran' > ${JSON.stringify(markerPath)}\n`, "utf8");
      await writeFile(
        allowlistProbePath,
        `
          set -Eeuo pipefail
          for key in BASH_ENV BASHOPTS ENV SHELLOPTS; do
            ! compgen -e | grep -Fxq "$key"
          done
          declare -A keep_env=([SAFE_VALUE]=1)
          while IFS= read -r key; do
            if [[ -z "\${keep_env[$key]+x}" ]]; then
              unset "$key"
            fi
          done < <(compgen -e)
          printf '%s' "\${SAFE_VALUE:?}"
        `,
        "utf8",
      );
      const env = buildQaRuntimeEnv({
        ...createParams({ SAFE_VALUE: "base" }),
        runtimeEnvPatch: {
          SAFE_VALUE: "allowlist-survived",
          BASH_ENV: bashEnvPath,
          BASHOPTS: "checkwinsize",
          ENV: bashEnvPath,
          SHELLOPTS: "braceexpand",
          "BASH_FUNC_compgen%%": `() { printf 'ran' > ${JSON.stringify(functionMarkerPath)}; builtin compgen "$@"; }`,
        },
      });

      for (const key of ["BASH_ENV", "BASHOPTS", "ENV", "SHELLOPTS"]) {
        expect(env[key]).toBeUndefined();
      }
      expect(env["BASH_FUNC_compgen%%"]).toBeUndefined();

      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", allowlistProbePath], {
        encoding: "utf8",
        env,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("allowlist-survived");
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(functionMarkerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("re-scrubs blocked credentials and source authority in a packaged gateway child", async () => {
    const tempParent = await tempDirs.makeTempDir("qa-gateway-env-scrub-");
    qaTempPathState.preferredTmpDir = tempParent;
    const observedEnvPath = path.join(tempParent, "observed-env.json");
    vi.stubEnv("OPENCLAW_QA_CONVEX_SECRET_MAINTAINER", "convex-maintainer-secret");
    const captureScript = [
      'const fs = require("node:fs");',
      "const env = {",
      "SAFE_VALUE: process.env.SAFE_VALUE,",
      "OPENCLAW_LIVE_SETUP_TOKEN_VALUE: process.env.OPENCLAW_LIVE_SETUP_TOKEN_VALUE,",
      "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN: process.env.OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN,",
      "OPENCLAW_QA_CONVEX_SECRET_CI: process.env.OPENCLAW_QA_CONVEX_SECRET_CI,",
      "OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: process.env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER,",
      '"BASH_FUNC_sudo%%": process.env["BASH_FUNC_sudo%%"],',
      "OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL: process.env.OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL,",
      "OPENCLAW_QA_TELEGRAM_GROUP_ID: process.env.OPENCLAW_QA_TELEGRAM_GROUP_ID,",
      "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: process.env.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN,",
      "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: process.env.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN,",
      "OPENCLAW_DEV_SOURCE_ROOT: process.env.OPENCLAW_DEV_SOURCE_ROOT,",
      "};",
      `fs.writeFileSync(${JSON.stringify(observedEnvPath)}, JSON.stringify(env));`,
    ].join("\n");

    const owner = ownGateway();
    await expect(
      owner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: ["--eval", captureScript],
          usePackagedPlugins: true,
        },
        runtimeEnvPatch: {
          SAFE_VALUE: "patched",
          "BASH_FUNC_sudo%%": "() { printf imported; }",
          OPENCLAW_DEV_SOURCE_ROOT: "/repo/caller-override",
          OPENCLAW_LIVE_SETUP_TOKEN_VALUE: "setup-token",
          OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN: "anthropic-setup-token",
          OPENCLAW_QA_CONVEX_SECRET_CI: "convex-ci-secret",
          OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL: "trusted-parent-only",
          OPENCLAW_QA_TELEGRAM_GROUP_ID: "-1001234567890",
          OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver-token",
          OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut-token",
        },
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({}),
        },
        transportBaseUrl: "http://127.0.0.1:43123",
      }),
    ).rejects.toThrow("gateway exited before listening");
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

    await expect(readFile(observedEnvPath, "utf8")).resolves.toBe(
      JSON.stringify({ SAFE_VALUE: "patched" }),
    );
  });

  it("clears inherited source authority when the repo CLI resolves to packaged plugins", async () => {
    const tempParent = await tempDirs.makeTempDir("qa-gateway-repo-cli-source-root-");
    const repoRoot = await tempDirs.makeTempDir("qa-gateway-repo-cli-");
    qaTempPathState.preferredTmpDir = tempParent;
    const observedEnvPath = path.join(tempParent, "observed-source-root");
    const runnerPath = path.join(repoRoot, "scripts", "run-node.mjs");
    await mkdir(path.dirname(runnerPath), { recursive: true });
    await writeFile(
      runnerPath,
      [
        'import fs from "node:fs";',
        `fs.writeFileSync(${JSON.stringify(observedEnvPath)}, process.env.OPENCLAW_DEV_SOURCE_ROOT ?? "");`,
      ].join("\n"),
      "utf8",
    );
    vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", "/repo/current-harness");

    const owner = ownGateway();
    await expect(
      owner.start({
        repoRoot,
        useRepoCli: true,
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({}),
        },
        transportBaseUrl: "http://127.0.0.1:43123",
      }),
    ).rejects.toThrow("gateway exited before listening");
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

    await expect(readFile(observedEnvPath, "utf8")).resolves.toBe("");
  });

  registerSourceGatewayHostLifelineTest({ tempDirs, qaTempPathState, ownGateway });

  it("requires an Anthropic key for live Claude CLI API-key mode", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");

    expect(() =>
      buildQaRuntimeEnv({
        ...createParams({
          HOME: hostHome,
        }),
        providerMode: "live-frontier",
        forwardHostHomeForClaudeCli: true,
        claudeCliAuthMode: "api-key",
      }),
    ).toThrow("Claude CLI API-key QA mode requires ANTHROPIC_API_KEY");
  });

  it("keeps explicit Codex CLI auth home for live frontier runs", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        CODEX_HOME: "/custom/codex-home",
        HOME: "/host/home",
      }),
      providerMode: "live-frontier",
    });

    expect(env.CODEX_HOME).toBe("/custom/codex-home");
  });

  it("scrubs direct and live provider keys in mock mode", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        ANTHROPIC_API_KEY: "anthropic-live",
        ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth",
        CODEX_API_KEY: "codex-live",
        GEMINI_API_KEY: "gemini-live",
        GEMINI_API_KEYS: "gemini-a gemini-b",
        GOOGLE_API_KEY: "google-live",
        OPENAI_API_KEY: "openai-live",
        OPENAI_API_KEYS: "openai-a,openai-b",
        CODEX_HOME: "/host/.codex",
        OPENCLAW_LIVE_ANTHROPIC_KEY: "anthropic-live",
        OPENCLAW_LIVE_ANTHROPIC_KEYS: "anthropic-a,anthropic-b",
        OPENCLAW_LIVE_CODEX_API_KEY: "codex-live",
        OPENCLAW_LIVE_GEMINI_KEY: "gemini-live",
        OPENCLAW_LIVE_OPENAI_KEY: "openai-live",
      }),
      providerMode: "mock-openai",
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEYS).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEYS).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.OPENCLAW_LIVE_OPENAI_KEY).toBeUndefined();
    expect(env.OPENCLAW_LIVE_ANTHROPIC_KEY).toBeUndefined();
    expect(env.OPENCLAW_LIVE_ANTHROPIC_KEYS).toBeUndefined();
    expect(env.OPENCLAW_LIVE_CODEX_API_KEY).toBeUndefined();
    expect(env.OPENCLAW_LIVE_GEMINI_KEY).toBeUndefined();
  });

  it("keeps a private restart marker visible after an unterminated log prefix", async () => {
    const output = createQaGatewayChildLogCollector();
    output.push(
      "stderr",
      Buffer.from("old restart mode: in-process restart\nunterminated warning"),
    );
    const mark = output.mark();
    const wait = waitForQaGatewayRestartBoundary({
      readLogsSince: (since) => output.readSince(since),
      mark,
      pollMs: 1,
      timeoutMs: 100,
    });

    output.push("stdout", Buffer.from("restart mode: in-process restart\n"));

    await expect(wait).resolves.toBeUndefined();
    expect(output.readRedactedSince(mark)).toBe("");
  });

  it("bounds diagnostics while monotonic marks retain fresh output semantics", () => {
    const output = createQaGatewayChildLogCollector();
    const childLogs = createQaGatewayChildLogAccess(output);
    output.push("stdout", Buffer.from(`old😀${"x".repeat(70_000)}\n`));
    const mark = childLogs.markLogs();
    expect(mark).toBeGreaterThan(output.text().length);
    output.push(
      "stdout",
      Buffer.from("fresh restart mode: in-process restart\nAuthorization: Bearer fixture-secret\n"),
    );

    expect(output.text()).toContain("[qa-lab] older gateway logs truncated");
    expect(output.text().length).toBeLessThan(66_000);
    expect(childLogs.markLogs()).toBeGreaterThan(mark);
    expect(childLogs.readLogsSince(mark)).toBe(
      "fresh restart mode: in-process restart\nAuthorization: Bearer ***\n",
    );
    expect(output.text()).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("redacts credentials whose pattern crosses a monotonic log cursor", () => {
    const bearerOutput = createQaGatewayChildLogCollector();
    const bearerLogs = createQaGatewayChildLogAccess(bearerOutput);
    bearerOutput.push("stdout", Buffer.from("Authorization: Bearer "));
    const bearerMark = bearerLogs.markLogs();
    bearerOutput.push("stdout", Buffer.from("fixture-secret-value\nfresh line\n"));

    expect(bearerLogs.readLogsSince(bearerMark)).toBe("fresh line\n");

    const telegramOutput = createQaGatewayChildLogCollector();
    const telegramLogs = createQaGatewayChildLogAccess(telegramOutput);
    telegramOutput.push("stdout", Buffer.from("123456789:"));
    const telegramMark = telegramLogs.markLogs();
    telegramOutput.push("stdout", Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef\nfresh line\n"));

    const freshTelegramLogs = telegramLogs.readLogsSince(telegramMark);
    expect(freshTelegramLogs).toBe("fresh line\n");
    expect(freshTelegramLogs).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef");

    const truncatedOutput = createQaGatewayChildLogCollector();
    const truncatedLogs = createQaGatewayChildLogAccess(truncatedOutput);
    truncatedOutput.push(
      "stdout",
      Buffer.from(`Authorization: Bearer ${"s".repeat(70_000)}\nfresh line\n`),
    );

    const freshTruncatedLogs = truncatedLogs.readLogsSince(0);
    expect(freshTruncatedLogs).toBe("[qa-lab] older gateway logs truncated\nfresh line\n");
    expect(freshTruncatedLogs).not.toContain("s".repeat(100));
  });

  it("decodes interleaved stdout and stderr independently", () => {
    const output = createQaGatewayChildLogCollector();
    const stdout = Buffer.from("before 😀 after\n");

    output.push("stdout", stdout.subarray(0, 9));
    output.push("stderr", Buffer.from("warning ⚠️\n"));
    output.push("stdout", stdout.subarray(9));

    expect(output.text()).toBe("before warning ⚠️\n😀 after");
    expect(output.text()).not.toContain("�");
  });

  it("keeps oversized restart-boundary poll intervals within the timeout", async () => {
    await expect(
      waitForQaGatewayRestartBoundary({
        readLogsSince: () => "signal SIGUSR2 received\n",
        mark: 0,
        pollMs: Number.MAX_SAFE_INTEGER,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("qa gateway child did not reach restart boundary");
  });

  it("lets a legacy packaged candidate create its auth DB before gateway spawn", async () => {
    const { owner, start, recordPath } = await createPackagedFixture({
      QA_LEGACY_PLUGIN_SETUP: "1",
      QA_CONFIG_RUNTIME_VERSION: "2026.7.33",
    });
    await expect(start()).rejects.toThrow("fixture gateway exit");
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

    const records = await readJsonLines(recordPath);
    const authRecords = records.filter((record) => record.kind === "auth");
    expect(authRecords).toHaveLength(2);
    expect(authRecords.map((record) => record.args)).toEqual(
      ["openai", "anthropic"].map((provider) => [
        "models",
        "auth",
        "--agent",
        "qa",
        "paste-api-key",
        "--provider",
        provider,
        "--profile-id",
        `qa-mock-${provider}`,
      ]),
    );
    for (const record of authRecords) {
      expect(record.stdin).toMatch(/^sk-qa-mock-[a-f0-9]{32}\n$/u);
      expect(record.env).toMatchObject({
        OPENCLAW_CLI: "1",
      });
      expect(record.configMode).toBe(0o600);
      expect(record.configRegular).toBe(true);
      expect(record.configSymlink).toBe(false);
    }
    expect(authRecords.map((record) => record.dbExists)).toEqual([false, true]);
    expect(records[0]).toMatchObject({
      kind: "auth",
      dbExists: false,
    });
    const authConfigPaths = authRecords.map((record) => String(record.configPath));
    expect(new Set(authConfigPaths).size).toBe(1);
    expect(authConfigPaths[0]).toBe(
      path.join(String(authRecords[0]?.stateDir), "qa-auth-bootstrap", "openclaw.json"),
    );
    expect(records.at(-1)).toMatchObject({
      kind: "gateway",
      authProfileIds: ["qa-mock-openai", "qa-mock-anthropic"],
      configVersion: "2026.7.33",
      dbExists: true,
    });
    expect(records.at(-1)?.configPath).not.toBe(authConfigPaths[0]);
    expect(records.at(-1)?.fixtureProfiles).toBeUndefined();
    expect(records.map((record) => record.kind)).toEqual([
      "auth",
      "auth",
      "help",
      "plugins",
      "gateway",
    ]);
    expect(records[2]?.args).toEqual(["update", "repair", "--help"]);
    expect(records[3]).toMatchObject({
      args: ["update", "repair", "--yes", "--no-restart", "--json"],
      configPath: records.at(-1)?.configPath,
      stateDir: records.at(-1)?.stateDir,
      configPort: records.at(-1)?.configPort,
    });
    expect(new Set(records.map((record) => record.authDbPath)).size).toBe(1);
  });

  it("preserves packaged config repair across migration convergence", async () => {
    const mutateConfig = vi.fn((cfg: OpenClawConfig) => cfg);
    const { start, recordPath } = await createPackagedFixture(
      {
        QA_STARTUP_RETRY: "migration",
        QA_CONFIG_RUNTIME_VERSION: "2026.7.33",
      },
      mutateConfig,
    );
    await expect(start()).rejects.toThrow("fixture gateway exit");
    const records = await readJsonLines(recordPath);
    const gateways = records.filter((record) => record.kind === "gateway");
    expect(gateways).toHaveLength(2);
    expect(gateways.map((record) => record.sourcePluginConfigured)).toEqual([false, false]);
    const repairs = records.filter((record) => record.kind === "plugins");
    expect(repairs).toHaveLength(1);
    for (const repair of repairs) {
      expect(repair.args).toContain("--accept-capabilities");
    }
    expect(repairs.map((record) => record.configPort)).toEqual([gateways[0]?.configPort]);
    expect(mutateConfig).toHaveBeenCalledTimes(1);
    expect(records.filter((record) => record.kind === "auth")).toHaveLength(2);
    expect(records.map((record) => record.kind)).toEqual([
      "auth",
      "auth",
      "help",
      "plugins",
      "gateway",
      "gateway",
    ]);
    expect(new Set(records.map((record) => record.stateDir)).size).toBe(1);
    for (const gateway of gateways) {
      expect(gateway.args).toContainEqual(String(gateway.configPort));
      expect(gateway).toMatchObject({
        dbExists: true,
        authProfileIds: ["qa-mock-openai", "qa-mock-anthropic"],
        configVersion: "2026.7.33",
      });
    }
    expect(gateways[1]?.configPort).toBe(gateways[0]?.configPort);
  });

  it("preserves authored newer-version metadata so the packaged candidate refuses it", async () => {
    const { start, recordPath } = await createPackagedFixture(
      { QA_CONFIG_RUNTIME_VERSION: "2026.7.33" },
      (cfg) => ({ ...cfg, meta: { lastTouchedVersion: "2026.9.4" } }),
    );
    await expect(start()).rejects.toThrow("config last written by newer runtime: 2026.9.4");
    await expect(lstat(recordPath)).rejects.toThrow(/ENOENT/u);
  });

  it.each(["anthropic", "help", "repair"] as const)(
    "blocks packaged gateway spawn with bounded redacted diagnostics when %s fails",
    async (phase) => {
      const provider = phase === "anthropic" ? phase : undefined;
      const { owner, start, recordPath, tempParentDir } = await createPackagedFixture({
        QA_FAIL_PROVIDER: provider,
        QA_FAIL_PLUGIN_SETUP: provider ? undefined : phase,
      });
      const error = await start().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error) || !(error.cause instanceof Error)) {
        throw new Error("expected package command failure retained by lifecycle");
      }
      const prefix = provider
        ? `installed package mock auth bootstrap failed for ${provider}: `
        : `installed package plugin setup failed (update repair${phase === "help" ? " --help" : ""}): `;
      const detail = provider
        ? "OpenClaw CLI exited 9: Authorization: Bearer <redacted>"
        : "OpenClaw CLI exited 8: plugin fixture rejected: Authorization: Bearer <redacted>";
      expect(error.message).toContain(`${prefix}${detail}\ncontext retained\n`);
      expect(error.cause.message.length).toBeLessThanOrEqual(prefix.length + 2_048);
      expect(error.cause.message).not.toContain("diagnostic ".repeat(400));
      expect(error.cause.message).toContain("terminal failure: Authorization: Bearer <redacted>");
      expect(error.cause).not.toHaveProperty("cause");
      const records = await readJsonLines(recordPath);
      expect(records.map((record) => record.kind)).toEqual(
        provider
          ? ["auth", "auth"]
          : ["auth", "auth", ...(phase === "repair" ? ["help"] : []), "plugins"],
      );
      expect(records[0]).toMatchObject({
        kind: "auth",
        dbExists: false,
        configMode: 0o600,
        configRegular: true,
        configSymlink: false,
      });
      const diagnostic = inspect(error, { depth: null });
      for (const authRecord of records.filter((record) => record.kind === "auth")) {
        const submittedKey = String(authRecord.stdin).trim();
        expect(submittedKey).toMatch(/^sk-qa-mock-[a-f0-9]{32}$/u);
        expect(diagnostic).not.toContain(submittedKey);
      }
      expect(diagnostic).not.toContain("fixture-plugin-secret");
      expect(diagnostic).not.toContain("fixture-tail-secret");
      const tempRoots = await readdir(tempParentDir);
      expect(tempRoots).toHaveLength(1);
      for (const stream of ["stdout", "stderr"]) {
        await expect(
          readFile(path.join(tempParentDir, tempRoots[0]!, `gateway.${stream}.log`), "utf8"),
        ).resolves.toBe("");
      }
      await expect(owner.stop()).resolves.toEqual({ process: "confirmed-stopped", errors: [] });
      await expect(readdir(tempParentDir)).resolves.toEqual([]);
    },
  );

  it("force-stops gateway children that ignore the graceful signal", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn((signal?: "SIGTERM" | "SIGKILL" | number) => {
        if (signal === "SIGKILL") {
          child.signalCode = "SIGKILL";
          queueMicrotask(() => child.emit("exit"));
        }
        return true;
      }),
    });
    const processKill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") {
        child.signalCode = "SIGKILL";
        queueMicrotask(() => child.emit("exit"));
      }
      if (signal === 0 && child.signalCode) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return true;
    });

    await stopQaGatewayChildProcessTree(
      child as unknown as Parameters<typeof stopQaGatewayChildProcessTree>[0],
      {
        gracefulTimeoutMs: 1,
        forceTimeoutMs: 10,
      },
    );

    if (process.platform === "win32") {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } else {
      expect(processKill).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(processKill).toHaveBeenCalledWith(-12345, "SIGKILL");
    }
    expect([child.exitCode, child.signalCode]).not.toEqual([null, null]);
  });

  it("force-closes a gateway log stream whose final flush never settles", async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final() {
        // Simulate the stalled filesystem flush observed in the release profile.
      },
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await closeQaGatewayLogStream(stream as never, "stdout", 1);

    expect(stream.destroyed).toBe(true);
    expect(stderr).toHaveBeenCalledWith(
      "[qa-suite] stdout gateway log flush exceeded 1ms; forcing close\n",
    );
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when forced gateway process-group shutdown times out",
    async () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        exitCode: null as number | null,
        signalCode: null as string | null,
        kill: vi.fn(() => true),
      });
      vi.spyOn(process, "kill").mockImplementation(() => true);

      await expect(
        stopQaGatewayChildProcessTree(child as never, {
          gracefulTimeoutMs: 1,
          forceTimeoutMs: 1,
          inspectLinuxProcessGroup: () => null,
        }),
      ).rejects.toThrow(
        process.platform === "linux"
          ? "qa gateway process tree remained alive after forced shutdown: pgid=12345 members=unknown (/proc unavailable) childExitRecorded=false"
          : "qa gateway process tree remained alive after forced shutdown: pid=12345 childExitRecorded=false",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not confirm shutdown when an exited leader's group probe is denied",
    async () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        exitCode: 17,
        signalCode: null,
        kill: vi.fn(() => false),
      });
      const realKill = process.kill.bind(process);
      const fault = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -child.pid) {
          throw Object.assign(new Error("owned fake group probe denied"), { code: "EPERM" });
        }
        return realKill(pid, signal);
      });
      try {
        await expect(
          stopQaGatewayChildProcessTree(child as never, {
            gracefulTimeoutMs: 1,
            forceTimeoutMs: 1,
            inspectLinuxProcessGroup: () => null,
          }),
        ).rejects.toThrow("process tree remained alive");
      } finally {
        fault.mockRestore();
      }
    },
  );

  it("reports Linux process-tree diagnostics when forced shutdown times out", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(() => true),
    });
    vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(
        stopQaGatewayChildProcessTree(child as never, {
          gracefulTimeoutMs: 1,
          forceTimeoutMs: 1,
          inspectLinuxProcessGroup: () => ({
            alive: true,
            diagnostics:
              'pgid=12345 members=[pid=12345 state=Z command="gateway", pid=12346 state=S command="worker"]',
          }),
        }),
      ).rejects.toThrow(
        'qa gateway process tree remained alive after forced shutdown: pgid=12345 members=[pid=12345 state=Z command="gateway", pid=12346 state=S command="worker"] childExitRecorded=false',
      );
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }
  });

  it("does not trust an exited gateway wrapper while its process group is alive", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 12346,
      exitCode: 0 as number | null,
      signalCode: null as string | null,
      kill: vi.fn(),
    });
    let sawForceKill = false;
    let postKillLivenessChecks = 0;
    const processKill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") {
        sawForceKill = true;
        return true;
      }
      if (signal === 0 && sawForceKill) {
        postKillLivenessChecks += 1;
        if (postKillLivenessChecks >= 2) {
          throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        }
      }
      return true;
    });

    await stopQaGatewayChildProcessTree(
      child as unknown as Parameters<typeof stopQaGatewayChildProcessTree>[0],
      {
        gracefulTimeoutMs: 1,
        forceTimeoutMs: 50,
        inspectLinuxProcessGroup: () => ({
          alive: !sawForceKill || postKillLivenessChecks < 2,
          diagnostics: 'pgid=12346 members=[pid=12347 state=S command="worker"]',
        }),
      },
    );

    if (process.platform === "win32") {
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(processKill).toHaveBeenCalledWith(-12346, "SIGTERM");
      expect(processKill).toHaveBeenCalledWith(-12346, "SIGKILL");
      expect(postKillLivenessChecks).toBe(2);
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("does not retry an incomplete migration-convergence diagnostic", () => {
    const details = "OpenClaw plugin migration inputs changed during startup convergence";
    expect(needsQaGatewayMigrationRestart(details)).toBe(false);
  });

  it("recognizes a complete migration convergence diagnostic", () => {
    expect(
      needsQaGatewayMigrationRestart(
        "OpenClaw plugin migration inputs changed during startup convergence; refusing readiness.",
      ),
    ).toBe(true);
  });

  it("preserves only sanitized gateway debug artifacts", async () => {
    const tempRoot = await tempDirs.makeTempDir("qa-gateway-preserve-src-");
    const repoRoot = await tempDirs.makeTempDir("qa-gateway-preserve-repo-");

    const stdoutLogPath = path.join(tempRoot, "gateway.stdout.log");
    const stderrLogPath = path.join(tempRoot, "gateway.stderr.log");
    const artifactDir = path.join(repoRoot, ".artifacts", "qa-e2e", "gateway-runtime");
    await mkdir(path.dirname(artifactDir), { recursive: true });
    await writeFile(
      stdoutLogPath,
      [
        "OPENCLAW_GATEWAY_TOKEN=qa-suite-token",
        'OPENAI_API_KEY="openai-live"',
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
    await writeFile(
      stderrLogPath,
      [
        "Authorization: Bearer secret+/token=123456",
        "Cookie: qa_session=secret-cookie; theme=dark",
        "Set-Cookie: qa_session=secret-cookie; HttpOnly",
        "x-api-key: secret-header-api-key",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(tempRoot, "state"), { recursive: true });
    await writeFile(path.join(tempRoot, "state", "secret.txt"), "do-not-copy", "utf8");

    await preserveQaGatewayDebugArtifacts({
      preserveToDir: artifactDir,
      stdoutLogPath,
      stderrLogPath,
      tempRoot,
      repoRoot,
    });

    expect((await readdir(artifactDir)).toSorted()).toEqual([
      "README.txt",
      "gateway.stderr.log",
      "gateway.stdout.log",
    ]);
    await expect(readFile(path.join(artifactDir, "gateway.stdout.log"), "utf8")).resolves.toBe(
      [
        "OPENCLAW_GATEWAY_TOKEN=<redacted>",
        "OPENAI_API_KEY=<redacted>",
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
    await expect(readFile(path.join(artifactDir, "gateway.stderr.log"), "utf8")).resolves.toBe(
      [
        "Authorization: Bearer <redacted>",
        "Cookie: <redacted>",
        "Set-Cookie: <redacted>",
        "x-api-key: <redacted>",
      ].join("\n"),
    );
    await expect(readFile(path.join(artifactDir, "README.txt"), "utf8")).resolves.toContain(
      "was not copied because it may contain credentials or auth tokens",
    );
    await expect(readFile(path.join(artifactDir, "README.txt"), "utf8")).resolves.not.toContain(
      tempRoot,
    );
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
