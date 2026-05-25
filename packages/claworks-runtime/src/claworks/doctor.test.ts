import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaworksRuntime, startClaworksRuntime, stopClaworksRuntime } from "../index.js";
import { runClaworksDoctor } from "./doctor.js";

describe("runClaworksDoctor connector guardrails", () => {
  let runtime: Awaited<ReturnType<typeof createClaworksRuntime>> | null = null;

  afterEach(async () => {
    if (runtime) {
      await stopClaworksRuntime(runtime);
      runtime = null;
    }
  });

  it("errors on simulate=true connectors when production_mode=true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-doctor-prod-sim-"));
    runtime = await createClaworksRuntime({
      production_mode: true,
      connectors: {
        plant: { preset: "mqtt", simulate: true, enabled: true },
      },
      data: { database_url: `sqlite://${join(dir, "doctor.db")}` },
      packs: { installed: ["base"], paths: [] },
    });
    await startClaworksRuntime(runtime);

    const checks = runClaworksDoctor(runtime);
    const simulate = checks.find((c) => c.id === "connectors_simulate");
    expect(simulate?.status).toBe("error");
  });

  it("errors on unknown connector preset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-doctor-bad-preset-"));
    runtime = await createClaworksRuntime({
      connectors: {
        kb: { preset: "filesystem-kb", enabled: true },
        bad: { preset: "unknown-preset", enabled: true },
      },
      data: { database_url: `sqlite://${join(dir, "doctor.db")}` },
      packs: { installed: ["base"], paths: [] },
    });
    // Do not start runtime — unknown preset fails connector resolution at start.

    const checks = runClaworksDoctor(runtime);
    const invalid = checks.find((c) => c.id === "connectors_invalid_preset");
    expect(invalid?.status).toBe("error");
    expect(invalid?.message).toContain("bad=unknown-preset");
  });

  it("errors on *-simulate preset suffix in production", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-doctor-sim-preset-"));
    runtime = await createClaworksRuntime({
      production_mode: true,
      connectors: {
        plant: { preset: "mqtt-simulate", enabled: true },
      },
      data: { database_url: `sqlite://${join(dir, "doctor.db")}` },
      packs: { installed: ["base"], paths: [] },
    });
    await startClaworksRuntime(runtime);

    const checks = runClaworksDoctor(runtime);
    const simulatePreset = checks.find((c) => c.id === "connectors_simulate_preset");
    expect(simulatePreset?.status).toBe("error");
  });
});
