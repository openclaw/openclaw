import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HealthCheck, HealthFinding, HealthRepairContext } from "openclaw/plugin-sdk/health";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";
import * as managedBinary from "./crabbox-managed-binary.js";
import { crabboxState } from "./crabbox-state.test-support.js";
import {
  warmImage,
  warmRecord,
  warmStore,
  captureOperation,
  expectText,
} from "./crabbox-warm-scenarios.test-support.js";
import {
  CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
  registerCrabboxWorkerProviderDoctorChecks,
  type CrabboxDoctorRegistrationHost,
} from "./doctor.js";

afterEach(() => vi.restoreAllMocks());

const CRABBOX_SETUP_SECRETS_CHECK_ID = "crabbox/setup-secrets";
const CRABBOX_WARM_IMAGES_CHECK_ID = "crabbox/warm-images";
const outdated = {
  severity: "warning",
  requirement: `Crabbox ${managedBinary.CRABBOX_MIN_VERSION} or newer`,
  fixHint: expect.stringContaining("openclaw doctor --fix"),
};
const protectedSecret = (id: string, provider = "default") => ({ source: "store", provider, id });
const context = (
  settings: Record<string, unknown> = {},
  overrides: Partial<HealthRepairContext> = {},
): HealthRepairContext => ({
  cfg: { cloudWorkers: { profiles: { worker: { provider: "crabbox", settings } } } },
  mode: "fix",
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  ...overrides,
});
function captureCrabboxDoctorCheck(
  id = CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
  inspectSetupSecrets: CrabboxDoctorRegistrationHost["inspectSetupSecrets"] = async (names) =>
    names.map((name) => ({ name, status: "missing" })),
): HealthCheck {
  const checks = new Map<string, HealthCheck>();
  registerCrabboxWorkerProviderDoctorChecks({
    openclawRoot: path.resolve(path.sep, "workspace", "openclaw"),
    inspectSetupSecrets,
    listPluginStateEntries: <T>(options: OpenKeyedStoreOptions) =>
      crabboxState.openKeyedStoreV2<T>(options).entries(),
    getHealthCheck: (key) => checks.get(key),
    registerHealthCheck: (value) => checks.set(value.id, value),
  });
  return checks.get(id)!;
}

describe("Crabbox worker doctor", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const workerContext = (target = "linux") => context({ binary: process.execPath, target });

  it.each(["unconfigured", "supported", "sandbox", "wsl2", "indeterminate"] as const)(
    "detects %s without installing or mutating config",
    async (kind) => {
      const probe = vi.spyOn(managedBinary, "probeCrabboxVersion");
      const install = vi.spyOn(managedBinary, "ensureManagedCrabboxBinary");
      if (kind !== "unconfigured") {
        probe.mockResolvedValue(
          kind === "supported"
            ? { status: "supported", version: managedBinary.CRABBOX_MIN_VERSION }
            : kind === "indeterminate"
              ? { status: "indeterminate", reason: "version command could not start" }
              : { status: "outdated", version: kind === "sandbox" ? "0.76.0" : "0.51.0" },
        );
      }
      const ctx =
        kind === "unconfigured"
          ? context({}, { cfg: {} })
          : kind === "sandbox"
            ? context(
                {},
                {
                  cfg: {
                    plugins: {
                      entries: { crabbox: { config: { sandbox: { binary: process.execPath } } } },
                    },
                  },
                  env: { OPENCLAW_STATE_DIR: tempDirs.make("crabbox-doctor-sandbox-"), PATH: "" },
                },
              )
            : workerContext(kind === "wsl2" ? "windows/wsl2" : "linux");
      const before = structuredClone(ctx.cfg);
      const expected =
        kind === "sandbox"
          ? {
              target: "sandbox",
              ocPath: "plugins.entries.crabbox.config.sandbox.binary",
              message: expect.stringContaining("Crabbox sandbox uses outdated Crabbox 0.76.0"),
              requirement: "Crabbox 0.79.2 or newer",
            }
          : kind === "wsl2"
            ? { ...outdated, target: "worker" }
            : {
                severity: "warning",
                message: expect.stringContaining("could not determine its Crabbox version"),
              };
      await expect(captureCrabboxDoctorCheck().detect(ctx)).resolves.toMatchObject(
        kind === "unconfigured" || kind === "supported" ? [] : [expected],
      );
      expect(ctx.cfg).toEqual(before);
      expect(probe).toHaveBeenCalledTimes(kind === "unconfigured" ? 0 : 1);
      expect(install).not.toHaveBeenCalled();
    },
  );

  it.each(["0.56.0", managedBinary.CRABBOX_MIN_VERSION])(
    "detects managed-only %s without downloading",
    async (version) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("crabbox-doctor-managed-"), PATH: "" };
      const target = path.basename(
        path.dirname(managedBinary.resolveManagedCrabboxBinaryPath(env)),
      );
      const binary = path.join(
        env.OPENCLAW_STATE_DIR,
        "tools",
        "crabbox",
        version,
        target,
        process.platform === "win32" ? "crabbox.exe" : "crabbox",
      );
      await mkdir(path.dirname(binary), { recursive: true });
      await writeFile(binary, version);
      const command = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockResolvedValue(commandResult({ stdout: version }));
      const install = vi.spyOn(managedBinary, "ensureManagedCrabboxBinary");
      const ctx = context({ binary: "/nonexistent/crabbox" }, { env });
      const check = captureCrabboxDoctorCheck();
      const findings = await check.detect(ctx);
      if (version === managedBinary.CRABBOX_MIN_VERSION) {
        expect(findings).toEqual([]);
        await expect(check.repair!(ctx, findings)).resolves.toMatchObject({ status: "skipped" });
        await expect(check.detect(ctx)).resolves.toEqual([]);
        expect(command).toHaveBeenCalledWith([binary, "--version"], expect.anything());
      } else {
        expect(findings).toMatchObject([outdated]);
        expect(command).not.toHaveBeenCalled();
      }
      expect(install).not.toHaveBeenCalled();
    },
  );

  it("repairs through the managed owner, preserving config", async () => {
    vi.spyOn(managedBinary, "resolveManagedCrabboxBinaryPath").mockReturnValue("/managed/crabbox");
    const install = vi
      .spyOn(managedBinary, "ensureManagedCrabboxBinary")
      .mockImplementation(async ({ binary = "crabbox" } = {}) => ({
        binary,
        version: managedBinary.CRABBOX_MIN_VERSION,
      }));
    const check = captureCrabboxDoctorCheck();
    const findings: HealthFinding[] = [
      { checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID, severity: "warning", message: "outdated" },
    ];
    const ctx = workerContext();
    await expect(check.repair!({ ...ctx, dryRun: true }, findings)).resolves.toMatchObject({
      status: "skipped",
    });
    expect(install).not.toHaveBeenCalled();
    const before = structuredClone(ctx.cfg);
    await expect(check.repair!(ctx, findings)).resolves.toMatchObject({
      status: "repaired",
      changes: ["Installed managed Crabbox at /managed/crabbox"],
    });
    expect(ctx.cfg).toEqual(before);
    install.mockRejectedValueOnce(new Error("checksum mismatch"));
    await expect(check.repair!(ctx, findings)).resolves.toMatchObject({
      status: "failed",
      warnings: ["checksum mismatch"],
    });
  });
});

describe("Crabbox warm-image doctor", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });

  it.each(["creating", "scrubbing", "uncertain", "retire", "unsupported"] as const)(
    "reports %s without mutation or provider probes",
    async (operation) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-crabbox-warm-doctor-") };
      const store = warmStore(env);
      const now = Date.now();
      const record = warmRecord({
        profileId: "linux-development",
        backend: "aws",
        machineClass: "standard",
        os: "linux",
        projectLabel: "github.com/example/project",
        image: warmImage("chk_last_good", { createdAtMs: now, lastDemandAtMs: now }),
      });
      if (operation === "unsupported") {
        record.captureUnsupported = {
          atMs: now,
          provider: "aws",
          message: "Native capture is unsupported by this coordinator.",
        };
      } else {
        record.operation =
          operation === "retire"
            ? { type: "retire", checkpointId: "chk_predecessor" }
            : captureOperation("capture-selector", {
                leaseId: "cbx_capture",
                provider: "aws",
                startedAtMs: now - (operation === "scrubbing" ? 1_200_000 : 0),
                phase: operation,
                ...(operation === "uncertain"
                  ? { checkpointIds: ["chk_interrupted_a", "chk_interrupted_b"] }
                  : {}),
              });
      }
      store.register("profile", record);
      const probe = vi.spyOn(managedBinary, "probeCrabboxVersion");
      const command = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockRejectedValue(new Error("Provider commands are forbidden in this Doctor proof"));
      const check = captureCrabboxDoctorCheck(CRABBOX_WARM_IMAGES_CHECK_ID);
      const ctx = context({}, { cfg: {}, env });
      const findings = await check.detect(ctx);

      expect(findings).toMatchObject([
        {
          checkId: CRABBOX_WARM_IMAGES_CHECK_ID,
          target: "profile",
          severity: operation === "creating" || operation === "unsupported" ? "info" : "warning",
          message: expect.stringContaining(
            "linux-development · aws · standard · linux · github.com/example/project",
          ),
          fixHint: expect.stringContaining(
            operation === "unsupported"
              ? "settings.warmImage: false"
              : "openclaw crabbox warm-images",
          ),
        },
      ]);
      if (operation === "unsupported") {
        expect(findings[0]?.message).toContain(record.captureUnsupported!.message);
        expectText(findings[0]?.fixHint, [
          "otherwise provision cold",
          "capture attempts are skipped until `warmImages.refreshAfter`",
          "supports native checkpoints",
        ]);
      } else if (operation === "uncertain") {
        expectText(findings[0]?.fixHint, ["chk_interrupted_a", "chk_interrupted_b"]);
        expect(findings[0]?.fixHint).toContain(
          "--recover capture-selector --acknowledge-provider-cleanup",
        );
      } else if (operation === "scrubbing") {
        expectText(
          findings[0]?.fixHint,
          ["may still be"],
          ["--recover", "Stop the owning Gateway"],
        );
        expect(findings[0]?.message).not.toContain("paused");
      }
      await check.repair?.(ctx, findings);
      expect(store.lookup("profile")).toEqual(record);
      expect(command).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    },
  );
});

describe("Crabbox setup secret migration", () => {
  const ready: CrabboxDoctorRegistrationHost["inspectSetupSecrets"] = async (names) =>
    names.map((name) => ({ name, status: "ready" }));

  it("skips inspection and commands without legacy names", async () => {
    const inspect = vi.fn(ready);
    const spawn = vi.spyOn(processRuntime, "runCommandWithTimeout");
    const check = captureCrabboxDoctorCheck(CRABBOX_SETUP_SECRETS_CHECK_ID, inspect);
    for (const cfg of [
      {},
      context().cfg,
      context({ setupSecrets: { TOKEN: protectedSecret("TOKEN") } }).cfg,
      context({ setupEnv: [] }).cfg,
    ]) {
      const ctx = context({}, { cfg });
      await check.detect(ctx);
      await check.repair!(ctx, []);
    }
    expect(inspect).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("migrates idempotently without mutating audit input", async () => {
    const check = captureCrabboxDoctorCheck(CRABBOX_SETUP_SECRETS_CHECK_ID, ready);
    const ctx = context({ setup: "install", setupEnv: ["TOKEN", "PASSWORD"], class: "standard" });
    const before = structuredClone(ctx.cfg);
    expect(await check.detect(ctx)).toHaveLength(1);
    expect(ctx.cfg).toEqual(before);
    expect(await check.repair!({ ...ctx, dryRun: true }, [])).toMatchObject({
      status: "skipped",
      changes: [],
    });
    expect(ctx.cfg).toEqual(before);
    const result = await check.repair!(ctx, []);
    expect(result).toMatchObject({ status: "repaired", warnings: [] });
    expect(result.config?.cloudWorkers?.profiles?.worker?.settings).toEqual({
      setup: "install",
      class: "standard",
      setupSecrets: {
        TOKEN: protectedSecret("TOKEN"),
        PASSWORD: protectedSecret("PASSWORD"),
      },
    });
    expect(ctx.cfg).toEqual(before);
    const repeated = { ...ctx, cfg: result.config! };
    expect(await check.detect(repeated)).toEqual([]);
    expect(await check.repair!(repeated, [])).toMatchObject({ status: "skipped", changes: [] });
  });

  it.each(["missing", "missing-bindings", "conflicting-value", "unavailable"] as const)(
    "preserves profiles with a %s secret",
    async (problem) => {
      const check = captureCrabboxDoctorCheck(CRABBOX_SETUP_SECRETS_CHECK_ID, async (names) =>
        names.map((name) => ({ name, status: name === "TOKEN" ? problem : "ready" })),
      );
      const ctx = context({ setupEnv: ["TOKEN", "PASSWORD"] });
      const result = await check.repair!(ctx, []);
      expect(result).toMatchObject({ status: "skipped", config: ctx.cfg, changes: [] });
      expectText(result.warnings?.join(" "), [problem, "allowed hosts"]);
    },
  );

  it.each(["conflicting", "compatible"])("preserves %s mappings during migration", async (kind) => {
    const conflict = kind === "conflicting";
    const check = captureCrabboxDoctorCheck(CRABBOX_SETUP_SECRETS_CHECK_ID, ready);
    const mapping = { TOKEN: protectedSecret(conflict ? "OTHER" : "TOKEN", "protected") };
    const ctx = context({ setupEnv: ["TOKEN"], setupSecrets: mapping });
    ctx.cfg.secrets = { defaults: { store: "protected" } };
    ctx.cfg.cloudWorkers!.profiles!.other = { provider: "crabbox", settings: { setupEnv: [] } };
    const result = await check.repair!(ctx, []);
    const profiles = result.config?.cloudWorkers?.profiles;
    expect(result.status).toBe("repaired");
    expect(profiles?.other?.settings).toEqual({ setupSecrets: {} });
    expect(profiles?.worker?.settings).toEqual(
      conflict ? ctx.cfg.cloudWorkers?.profiles?.worker?.settings : { setupSecrets: mapping },
    );
    if (conflict) {
      expect(profiles?.worker).toEqual(ctx.cfg.cloudWorkers?.profiles?.worker);
      expect(result.warnings?.join(" ")).toContain("conflicts");
    }
  });
});
