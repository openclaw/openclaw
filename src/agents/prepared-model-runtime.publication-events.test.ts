import { describe, expect, it, vi } from "vitest";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  createCatalogAttemptReporter,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.publication-events.js";

describe("catalog attempt status publication", () => {
  it.each(["provider", "native"] as const)(
    "separates %s auth rejection from refresh failure",
    (kind) => {
      const reporter = createCatalogAttemptReporter(
        {},
        { key: "synthetic", pluginFingerprint: "synthetic", credentials: {} },
        () => true,
        () => {},
      );
      const rejected = { provider: "signed-out", status: "auth-rejected" } as const;
      const unavailable = { provider: "unreachable", status: "unavailable" } as const;
      const publish = (outcomes: NonNullable<ModelCatalogSnapshot["providerOutcomes"]>) =>
        reporter.withRefreshStatus({
          entries: [],
          routeVariants: [],
          ...(kind === "native"
            ? { nativeProviderOutcomes: { "native-app": outcomes } }
            : { providerOutcomes: outcomes }),
        });

      const rejectedCatalog = publish([rejected]);
      expect(rejectedCatalog.refreshFailed).toBeUndefined();
      expect(publish([rejected, unavailable]).refreshFailed).toBe(true);

      // A thrown acquisition failure is independent of a determinate provider outcome.
      reporter.failed(new Error("catalog request timed out"), ["unreachable"], kind);
      expect(rejectedCatalog.refreshFailed).toBe(true);
      reporter.published(["unreachable"], kind);
      expect(rejectedCatalog.refreshFailed).toBeUndefined();
    },
  );

  it("reports partial and complete native settlement without marking model facts changed", () => {
    const kind = "native";
    const events = vi.fn<Parameters<typeof registerPreparedModelRuntimePublicationListener>[0]>();
    const unregister = registerPreparedModelRuntimePublicationListener(events);
    const reporter = createCatalogAttemptReporter(
      {},
      { key: "synthetic", pluginFingerprint: "synthetic", credentials: {} },
      () => true,
      () => {},
    );
    const catalog: ModelCatalogSnapshot = reporter.withRefreshStatus({
      entries: [],
      routeVariants: [],
    });
    const publication = () => ({
      previous: { catalog },
      current: { catalog },
      staticCatalog: catalog,
    });
    try {
      reporter.setPending(["custom", "sibling"], kind);
      reporter.setPending(["custom", "sibling"], kind);
      expect(events).toHaveBeenCalledExactlyOnceWith({
        phase: "catalog-status",
        modelFactsChanged: false,
      });
      reporter.published(["unrelated"], kind, publication);
      expect(catalog.pendingProviders).toEqual(["custom", "sibling"]);
      reporter.published(["custom"], kind, publication);
      expect(catalog.pendingProviders).toEqual(["sibling"]);
      reporter.published(["custom"], kind, publication);
      expect(catalog.pendingProviders).toEqual(["sibling"]);
      reporter.published(undefined, kind, publication);
      expect(catalog.pendingProviders).toBeUndefined();
      reporter.published(undefined, kind, publication);
      expect(events.mock.calls.map(([event]) => event)).toEqual([
        { phase: "catalog-status", modelFactsChanged: false },
        { phase: "catalog-published", modelFactsChanged: false },
        { phase: "catalog-published", modelFactsChanged: false, refreshStatusChanged: true },
        { phase: "catalog-published", modelFactsChanged: false },
        { phase: "catalog-published", modelFactsChanged: false, refreshStatusChanged: true },
        { phase: "catalog-published", modelFactsChanged: false },
      ]);
    } finally {
      unregister();
    }
  });
});

it("keeps retained catalog status readable without retaining acquisition callbacks", () => {
  const output = execNodeEvalSync(
    `import assert from "node:assert/strict";
     import { expectCollected } from ${JSON.stringify(new URL("../test-utils/retention.ts", import.meta.url).href)};
     import { createCatalogAttemptReporter } from ${JSON.stringify(new URL("./prepared-model-runtime.publication-events.ts", import.meta.url).href)};
     class Acquisition { active = true; }
     function publish() {
       const acquisition = new Acquisition();
       const reporter = createCatalogAttemptReporter({},
         { key: "synthetic", pluginFingerprint: "synthetic", credentials: {} },
         () => true, () => assert.ok(acquisition.active));
       reporter.setPending(["synthetic"]);
       const catalog = reporter.withRefreshStatus({ entries: [], routeVariants: [] });
       return { catalog, acquisition: new WeakRef(acquisition) };
     }
     const retained = publish();
     await expectCollected(retained.acquisition);
     assert.deepEqual(retained.catalog.pendingProviders, ["synthetic"]);
     assert.equal(retained.catalog.refreshFailed, undefined);
     console.log("Acquisition released; status retained");`,
    { imports: ["./scripts/tsx.mjs"], execArgv: ["--expose-gc"], timeout: 10_000 },
  );
  expect(output.trim()).toBe("Acquisition released; status retained");
});
