import { Command } from "commander";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import {
  captureOperation,
  expectText,
  warmImage,
  warmAllocation,
  warmRecord,
} from "./crabbox-warm-scenarios.test-support.js";
import { registerCrabboxWarmImageCommands } from "./crabbox-worker-warm-image-cli.js";
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
  const operation = captureOperation(SELECTOR, {
    startedAtMs: Date.now() - 1_200_000,
    phase,
    ...(phase === "uncertain" ? { checkpointIds: ["chk_interrupted_a", "chk_interrupted_b"] } : {}),
  });
  const record = warmRecord({
    image: warmImage("chk_last_good"),
    operation,
  });
  openWarmImageStore().register("profile", record);
  return { ...record, operation };
}

async function runCli(...args: string[]) {
  output = "";
  const program = new Command().exitOverride();
  registerCrabboxWarmImageCommands(program, crabboxState);
  await program.parseAsync(["crabbox", "warm-images", ...args], { from: "user" });
}

const recover = (selector = SELECTOR, ...args: string[]) =>
  runCli("--recover", selector, "--acknowledge-provider-cleanup", ...args);
const retiring = warmRecord({
  image: warmImage("chk_replacement"),
  operation: { type: "retire", checkpointId: "chk_predecessor" },
});

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
      "capture attempts are skipped until warmImages.refreshAfter has elapsed since the refusal",
      "settings.warmImage: false",
    ],
    ["--recover"],
  );
  expect(openWarmImageStore().lookup("profile")).toEqual(record);
});

it("rejects unacknowledged or changed legacy allocation selectors", async () => {
  const legacy = createPluginStateSyncKeyedStoreForTests<{ machineClass: string }>("crabbox", {
    namespace: "warm-leases",
    maxEntries: 256,
  });
  legacy.register("cbx_legacy", { machineClass: "standard" });
  await runCli("--json");
  const { selector, ...lease } = JSON.parse(output).legacyLeases[0];
  expect(lease).toMatchObject({ leaseId: "cbx_legacy", machineClass: "standard" });
  await expect(runCli("--recover", selector)).rejects.toThrow("--acknowledge-provider-cleanup");
  legacy.register("cbx_legacy", { machineClass: "fast" });
  await expect(recover(selector)).rejects.toThrow("selector is absent or changed");
  expect(legacy.lookup("cbx_legacy")).toEqual({ machineClass: "fast" });
});

it("recovers only the exact selected capture without clearing retained images or retirement", async () => {
  const original = pendingCapture();
  const record = {
    ...original,
    previous: warmImage("chk_previous"),
    operation: { ...original.operation, leaseId: "cbx_capture_source" },
    allocations: {
      cbx_capture_source: warmAllocation(),
      cbx_other: warmAllocation({ kind: "checkpoint", checkpointId: "chk_last_good" }),
    },
  };
  openWarmImageStore().register("profile", record);
  await expect(runCli("--acknowledge-provider-cleanup")).rejects.toThrow("requires --recover");
  expect(openWarmImageStore().lookup("profile")).toEqual(record);
  openWarmImageStore().register("other", retiring);

  await recover(SELECTOR, "--json");

  expect(JSON.parse(output).recoveredCapture).toBe(SELECTOR);
  expect(openWarmImageStore().lookup("profile")).toEqual({
    ...record,
    operation: undefined,
    allocations: { cbx_other: record.allocations.cbx_other },
  });
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
    openWarmImageStore().register("retiring", retiring);

    await runCli();

    if (phase === "uncertain") {
      expectText(output, [
        `openclaw crabbox warm-images --recover ${SELECTOR} --acknowledge-provider-cleanup`,
        "Stop the owning Gateway and capture processes",
        "chk_interrupted_a",
        "chk_interrupted_b",
      ]);
    } else {
      expectText(output, ["may still be"], ["paused", "--recover", "Stop the owning Gateway"]);
    }
    expect(output).toContain("Checkpoint deletion pending: chk_predecessor");
    expect(openWarmImageStore().lookup("profile")).toEqual(record);
  },
);
