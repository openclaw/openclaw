import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaworksRuntime, startClaworksRuntime, stopClaworksRuntime } from "./runtime.js";

describe("claworks runtime", () => {
  let cleanup: (() => void) | null = null;

  afterEach(async () => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it("loads packs and triggers playbook from event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claworks-test-"));
    const runtime = await createClaworksRuntime({
      data: { database_url: `sqlite://${join(dir, "test.db")}` },
      packs: {
        paths: [join(process.cwd(), "../claworks-packs")],
        installed: ["base", "process-industry"],
      },
    });
    cleanup = () => {
      void stopClaworksRuntime(runtime);
    };

    await startClaworksRuntime(runtime);

    expect(runtime.playbookEngine.list().length).toBeGreaterThan(0);
    expect(runtime.ontology.listTypes().length).toBeGreaterThan(0);

    const matches = await runtime.kernel.publish("alarm.created", "test", {
      mro_alarm_to_wo: true,
      alarm_id: "alm-1",
    });
    expect(matches.some((m) => m.playbookId === "mro_alarm_to_workorder")).toBe(true);

    await stopClaworksRuntime(runtime);
    cleanup = null;
  });
});
