import path from "node:path";
import type { HealthCheck, HealthRepairContext } from "openclaw/plugin-sdk/health";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as managedBinary from "./crabbox-managed-binary.js";
import {
  openCrabboxWarmImageStore,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";
import {
  CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
  registerCrabboxWorkerProviderDoctorChecks,
} from "./doctor.js";

const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
const CRABBOX_WARM_IMAGES_CHECK_ID = "crabbox/warm-images";

function captureCrabboxDoctorCheck(id = CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID): HealthCheck {
  const checks = new Map<string, HealthCheck>();
  registerCrabboxWorkerProviderDoctorChecks({
    openclawRoot: OPENCLAW_ROOT,
    getHealthCheck: (key) => checks.get(key),
    registerHealthCheck(value) {
      checks.set(value.id, value);
    },
  });
  const check = checks.get(id);
  if (!check) {
    throw new Error("Crabbox doctor check was not registered");
  }
  return check;
}

describe("Crabbox worker doctor", () => {
  afterEach(() => vi.restoreAllMocks());
  const context = (target = "linux"): HealthRepairContext => ({
    mode: "fix",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    cfg: {
      cloudWorkers: {
        profiles: {
          worker: { provider: "crabbox", settings: { binary: process.execPath, target } },
        },
      },
    },
  });

  it("does not probe or install without configured profiles", async () => {
    const probe = vi.spyOn(managedBinary, "probeCrabboxVersion");
    const install = vi.spyOn(managedBinary, "ensureManagedCrabboxBinary");
    await expect(captureCrabboxDoctorCheck().detect({ cfg: {} } as never)).resolves.toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("accepts a supported configured executable without downloading", async () => {
    const probe = vi
      .spyOn(managedBinary, "probeCrabboxVersion")
      .mockResolvedValue({ status: "supported", version: "0.56.0" });
    const install = vi.spyOn(managedBinary, "ensureManagedCrabboxBinary");
    await expect(captureCrabboxDoctorCheck().detect(context())).resolves.toEqual([]);
    expect(probe).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
  });

  it.each(["linux", "windows/wsl2", "windows/normal", "macos"])(
    "offers the same managed repair for outdated %s profiles without installing during detection",
    async (target) => {
      vi.spyOn(managedBinary, "probeCrabboxVersion").mockResolvedValue({
        status: "outdated",
        version: "0.51.0",
      });
      const install = vi.spyOn(managedBinary, "ensureManagedCrabboxBinary");
      await expect(captureCrabboxDoctorCheck().detect(context(target))).resolves.toEqual([
        expect.objectContaining({
          severity: "warning",
          target: "worker",
          requirement: "Crabbox 0.56.0 or newer",
          fixHint: expect.stringContaining("openclaw doctor --fix"),
        }),
      ]);
      expect(install).not.toHaveBeenCalled();
    },
  );

  it("accepts the existing managed executable when the configured one is outdated", async () => {
    vi.spyOn(managedBinary, "resolveManagedCrabboxBinaryPath").mockReturnValue(process.execPath);
    vi.spyOn(managedBinary, "probeCrabboxVersion").mockResolvedValue({
      status: "supported",
      version: "0.56.0",
    });
    const ctx = context();
    ctx.cfg.cloudWorkers!.profiles!.worker!.settings = { binary: "/nonexistent/crabbox" };
    await expect(captureCrabboxDoctorCheck().detect(ctx)).resolves.toEqual([]);
  });

  it("reports an indeterminate executable as repairable", async () => {
    vi.spyOn(managedBinary, "probeCrabboxVersion").mockResolvedValue({
      status: "indeterminate",
      reason: "version command could not start",
    });
    await expect(captureCrabboxDoctorCheck().detect(context())).resolves.toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("could not determine its Crabbox version"),
      }),
    ]);
  });

  it("installs through the shared owner on repair and preserves configuration", async () => {
    vi.spyOn(managedBinary, "resolveManagedCrabboxBinaryPath").mockReturnValue("/managed/crabbox");
    const install = vi
      .spyOn(managedBinary, "ensureManagedCrabboxBinary")
      .mockImplementation(async ({ binary } = {}) => ({
        binary: binary ?? "crabbox",
        version: "0.56.0",
      }));
    const check = captureCrabboxDoctorCheck();
    const findings = [{ checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID }] as never;
    const ctx = context();
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
  afterEach(() => {
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "healthy checkpoint", operation: undefined, severity: undefined },
    { name: "fresh capture", operation: "capture", severity: "info" },
    { name: "long-running capture", operation: "stale", severity: "warning" },
    { name: "long-running scrub", operation: "stale-scrub", severity: "warning" },
    { name: "failed capture", operation: "uncertain", severity: "warning" },
    { name: "pending retirement", operation: "retire", severity: "warning" },
  ] as const)(
    "reports $name without repairing state or probing providers",
    async ({ operation, severity }) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-crabbox-warm-doctor-") };
      const store = openCrabboxWarmImageStore(env);
      const now = Date.now();
      const record: WarmProfileRecord = {
        version: 3,
        profileId: "linux-development",
        backend: "aws",
        machineClass: "standard",
        os: "linux",
        projectLabel: "github.com/example/project",
        allocations: {},
        image: {
          checkpointId: "chk_last_good",
          kind: "native",
          state: "available",
          createdAtMs: now,
          preparationKey: null,
          cacheKey: null,
          purpose: null,
          lastDemandAtMs: now,
        },
        ...(operation
          ? {
              operation:
                operation === "retire"
                  ? { type: "retire" as const, checkpointId: "chk_predecessor" }
                  : {
                      type: "capture" as const,
                      id: "capture-selector",
                      startedAtMs:
                        now -
                        (operation === "stale" || operation === "stale-scrub" ? 1_200_000 : 0),
                      leaseId: "cbx_capture",
                      provider: "aws",
                      phase:
                        operation === "uncertain"
                          ? ("uncertain" as const)
                          : operation === "stale-scrub"
                            ? ("scrubbing" as const)
                            : ("creating" as const),
                    },
            }
          : {}),
      };
      store.register("profile", record);
      const probe = vi.spyOn(managedBinary, "probeCrabboxVersion");
      const command = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockRejectedValue(new Error("Provider commands are forbidden in this Doctor proof"));
      const check = captureCrabboxDoctorCheck(CRABBOX_WARM_IMAGES_CHECK_ID);
      const context: HealthRepairContext = {
        cfg: {},
        env,
        mode: "fix",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      };

      const findings = await check.detect(context);

      expect(findings).toEqual(
        severity
          ? [
              expect.objectContaining({
                checkId: CRABBOX_WARM_IMAGES_CHECK_ID,
                target: "profile",
                severity,
                message: expect.stringContaining(
                  "linux-development · aws · standard · linux · github.com/example/project",
                ),
                fixHint: expect.stringContaining("openclaw crabbox warm-images"),
              }),
            ]
          : [],
      );
      if (operation === "uncertain") {
        expect(findings[0]?.fixHint).toContain(
          "--recover capture-selector --acknowledge-provider-cleanup",
        );
      } else if (operation === "stale" || operation === "stale-scrub") {
        expect(findings[0]?.fixHint).toContain("may still be");
        expect(findings[0]?.message).not.toContain("paused");
        expect(findings[0]?.fixHint).not.toContain("--recover");
        expect(findings[0]?.fixHint).not.toContain("Stop the owning Gateway");
      }
      await check.repair?.(context, findings);
      expect(store.lookup("profile")).toEqual(record);
      expect(command).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it.each([CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID, CRABBOX_WARM_IMAGES_CHECK_ID])(
    "registers each check once when %s was already loaded",
    (existingId) => {
      const checks = new Map([[existingId, captureCrabboxDoctorCheck(existingId)]]);
      const registerHealthCheck = vi.fn((check: HealthCheck) => checks.set(check.id, check));
      const host = {
        openclawRoot: OPENCLAW_ROOT,
        getHealthCheck: (id: string) => checks.get(id),
        registerHealthCheck,
      };

      registerCrabboxWorkerProviderDoctorChecks(host);
      registerCrabboxWorkerProviderDoctorChecks(host);

      expect([...checks.keys()].toSorted()).toEqual(
        [CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID, CRABBOX_WARM_IMAGES_CHECK_ID].toSorted(),
      );
      expect(registerHealthCheck).toHaveBeenCalledOnce();
    },
  );
});
