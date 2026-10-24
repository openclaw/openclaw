import { Command } from "commander";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import {
  captureOperation,
  expectText,
  warmImage,
  warmRecord,
} from "./crabbox-warm-scenarios.test-support.js";
import { registerCrabboxWarmImageCommands } from "./crabbox-worker-warm-image-cli.js";
import {
  assertCrabboxWarmImageMigrationReady,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";
import { tempDirs } from "./crabbox-worker-warm-image.test-support.js";

const SELECTOR = "83eb5c1e-e408-4b64-9575-f8670287e294";
let output = "";

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-warm-cli-"));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

function pendingCapture(phase: "scrubbing" | "creating" | "uncertain" = "creating") {
  const now = Date.now();
  const record = {
    ...warmRecord(),
    image: warmImage("chk_last_good", { createdAtMs: now - 86_400_000, lastDemandAtMs: now }),
    operation: captureOperation(SELECTOR, { startedAtMs: now - 1_200_000, phase }),
  };
  openWarmImageStore().register("profile", record);
  return record;
}

async function runCli(...args: string[]) {
  output = "";
  const program = new Command().exitOverride();
  registerCrabboxWarmImageCommands(program, crabboxState);
  await program.parseAsync(["crabbox", "warm-images", ...args], { from: "user" });
}

const recover = (selector = SELECTOR, ...args: string[]) =>
  runCli("--recover", selector, "--acknowledge-provider-cleanup", ...args);

it("prints cold-only guidance for unsupported capture without changing local state", async () => {
  const record = warmRecord({
    captureUnsupported: {
      atMs: Date.now(),
      provider: "hetzner",
      message: "Native capture is unsupported by this coordinator.",
    },
  });
  openWarmImageStore().register("profile", record);

  await runCli();

  expectText(
    output,
    [
      "Capture unsupported: Native capture is unsupported by this coordinator.",
      "use an existing compatible snapshot when one is available",
      "capture attempts are skipped until warmImages.refreshAfter",
      "has elapsed since the refusal",
      "settings.warmImage: false",
    ],
    ["--recover"],
  );
  expect(openWarmImageStore().lookup("profile")).toEqual(record);
});

it("recovers a legacy allocation only after acknowledgment of the exact unchanged row", async () => {
  const legacy = createPluginStateSyncKeyedStoreForTests<{ machineClass: string }>("crabbox", {
    namespace: "warm-leases",
    maxEntries: 256,
  });
  legacy.register("cbx_legacy", { machineClass: "standard" });
  await expect(assertCrabboxWarmImageMigrationReady(crabboxState)).rejects.toThrow(
    "legacy worker allocations",
  );
  await runCli("--json");
  const { selector, ...lease } = JSON.parse(output).legacyLeases[0];
  expect(lease).toMatchObject({ leaseId: "cbx_legacy", machineClass: "standard" });
  await expect(runCli("--recover", selector)).rejects.toThrow("--acknowledge-provider-cleanup");
  legacy.register("cbx_legacy", { machineClass: "fast" });
  await expect(recover(selector)).rejects.toThrow("selector is absent or changed");
  expect(legacy.lookup("cbx_legacy")).toEqual({ machineClass: "fast" });
  await runCli("--json");
  await recover(JSON.parse(output).legacyLeases[0].selector);
  expect(legacy.lookup("cbx_legacy")).toBeUndefined();
  await expect(assertCrabboxWarmImageMigrationReady(crabboxState)).resolves.toBeUndefined();
});

it("recovers only the exact selected capture without clearing retained images or retirement", async () => {
  const record = pendingCapture();
  await expect(runCli("--acknowledge-provider-cleanup")).rejects.toThrow("requires --recover");
  expect(openWarmImageStore().lookup("profile")).toEqual(record);
  const retiring: WarmProfileRecord = {
    ...record,
    image: { ...record.image, checkpointId: "chk_replacement" },
    operation: { type: "retire", checkpointId: "chk_predecessor" },
  };
  openWarmImageStore().register("other", retiring);

  await recover(SELECTOR, "--json");

  expect(JSON.parse(output).recoveredCapture).toBe(SELECTOR);
  expect(openWarmImageStore().lookup("profile")).toEqual({ ...record, operation: undefined });
  expect(openWarmImageStore().lookup("other")).toEqual(retiring);
  const replacement = {
    ...record,
    operation: { ...record.operation, id: "replacement-selector" },
  };
  openWarmImageStore().register("profile", replacement);
  await expect(recover()).rejects.toThrow("selector is absent or changed");
  expect(openWarmImageStore().lookup("profile")).toEqual(replacement);
});

it.each(["scrubbing", "uncertain"] as const)(
  "prints guidance for an old %s capture and pending deletion",
  async (phase) => {
    const record = pendingCapture(phase);
    openWarmImageStore().register("retiring", {
      ...record,
      operation: { type: "retire", checkpointId: "chk_predecessor" },
    });

    await runCli();

    if (phase === "uncertain") {
      expectText(output, [
        `openclaw crabbox warm-images --recover ${SELECTOR} --acknowledge-provider-cleanup`,
        "Stop the owning Gateway and capture processes",
      ]);
    } else {
      expectText(output, ["may still be"], ["paused", "--recover", "Stop the owning Gateway"]);
    }
    expect(output).toContain("Checkpoint deletion pending: chk_predecessor");
    expect(openWarmImageStore().lookup("profile")).toEqual(record);
  },
);
