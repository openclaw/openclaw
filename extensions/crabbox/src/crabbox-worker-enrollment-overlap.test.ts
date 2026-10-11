import { describe, expect, it, vi } from "vitest";
import {
  createNodeBootstrapFixture,
  createWorkerArchiveFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";
import { commandResult, nodeEnrollmentFixture } from "./crabbox-worker-provider.test-support.js";
import { resolveCrabboxProvisionBaseTimeoutMs } from "./crabbox-worker-timeouts.js";
import {
  createWarmProvider,
  PROFILE,
  OPERATION_ID,
  LEASE_ID,
} from "./crabbox-worker-warm-image.test-support.js";

describe("ordinary cloud runtime preparation", () => {
  it.each([false, true])(
    "prepares both archives before ordinary enrollment (setup failure=%s)",
    async (fail) => {
      const events: string[] = [];
      const profile = { ...PROFILE, warmImage: false };
      const windowMs = 95 * 60_000;
      let elapsedMs = 0;
      vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
      const workerBundle = createWorkerArchiveFixture();
      const nodeBootstrap = createNodeBootstrapFixture();
      const { provider, calls } = createWarmProvider(async ({ argv, options }) => {
        if (argv[1] === "run") {
          const script = String(options?.input);
          const descriptor = script.match(/const workerBundle = (.*);/)![1]!;
          const artifact = descriptor === "undefined" ? undefined : JSON.parse(descriptor);
          expect(options.timeoutMs).toBe(windowMs);
          if (artifact) {
            elapsedMs += windowMs;
            events.push("runtime setup");
            expect(artifact).toEqual({
              url: workerBundle.url,
              sha256: workerBundle.sha256,
              bytes: workerBundle.bytes,
              packageRelativePath: workerBundle.packageRelativePath,
            });
            expect(script).toContain("await Promise.allSettled([");
            expect(script).toContain(
              "downloadArchive(workerBundle, tokens.workerBundle, downloadedWorker",
            );
            expect(script).not.toContain(workerBundle.token);
            expect(script).not.toContain(nodeBootstrap.token);
            return commandResult({ code: fail ? 1 : 0 });
          }
          events.push("enrollment setup");
        }
        return undefined;
      });
      const provision = provider.provision(profile, OPERATION_ID, {
        nodeBootstrapTimeoutMs: windowMs,
        assertCurrent: () => {},
        prepareNodeRuntime: async () => {
          elapsedMs = resolveCrabboxProvisionBaseTimeoutMs(profile);
          events.push("runtime grant");
          return { nodeBootstrap, workerBundle, bootstrapTimeoutMs: windowMs };
        },
        beginNodeEnrollment: async () => {
          events.push("enrollment grant");
          return {
            ...nodeEnrollmentFixture("synthetic-setup", "Cloud worker test"),
            bootstrapTimeoutMs: windowMs,
          };
        },
      });
      if (fail) {
        await expect(provision).rejects.toThrow("node runtime preparation");
        expect(events).toEqual(["runtime grant", "runtime setup"]);
        expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
      } else {
        await expect(provision).resolves.toMatchObject({ leaseId: LEASE_ID });
        expect(events).toEqual([
          "runtime grant",
          "runtime setup",
          "enrollment grant",
          "enrollment setup",
        ]);
      }
    },
  );
});
