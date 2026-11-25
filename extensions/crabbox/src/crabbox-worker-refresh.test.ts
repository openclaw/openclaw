import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import { createWarmProvider, PROFILE } from "./crabbox-worker-warm-image.test-support.js";

type Project = NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]>;

it("refreshes through the preparation transport on the existing lease without capturing or enrolling", async () => {
  const { provider, calls } = createWarmProvider();
  const signal = new AbortController().signal;
  const project: Project = {
    key: "a".repeat(64),
    baseCommit: "b".repeat(40),
    signal,
    assertCurrent: () => {},
    prepare: async (transport) => {
      await transport.upload("/fixture/project.pack", "/fixture/incoming.pack", signal);
      await transport.runScript("refresh-project", signal);
      return {
        seedKey: "a".repeat(64),
        cacheHit: true,
        captureSkipped: "Detected dependency installation failed; starting without a snapshot",
      };
    },
  };

  await provider.refreshPreparedProject?.({ leaseId: "cbx_existing", profile: PROFILE }, project);

  expect(calls.map(({ argv }) => argv[1])).toEqual(["cp", "run"]);
  expect(calls[0]?.argv).toContain("cbx_existing");
  expect(calls[1]?.argv).toContain("cbx_existing");
  expect(calls[1]?.options.input).toBe("refresh-project");
});

it.each(["abort", "authority"] as const)(
  "does not run a retained refresh transport after %s closes its owner",
  async (closure) => {
    const { provider, calls } = createWarmProvider();
    const controller = new AbortController();
    let current = true;
    const project: Project = {
      key: "a".repeat(64),
      baseCommit: "b".repeat(40),
      signal: controller.signal,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Preparation owner closed");
        }
      },
      prepare: async (transport) => {
        if (closure === "abort") {
          controller.abort(new Error("Preparation owner closed"));
        } else {
          current = false;
        }
        await transport.runScript("must-not-run", controller.signal);
        return { seedKey: "a".repeat(64), cacheHit: true };
      },
    };

    await expect(
      provider.refreshPreparedProject?.({ leaseId: "cbx_existing", profile: PROFILE }, project),
    ).rejects.toThrow("Preparation owner closed");
    expect(calls).toEqual([]);
  },
);
