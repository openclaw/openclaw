import { describe, expect, it, vi } from "vitest";
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

  it.each(["provider", "native"] as const)(
    "reports partial and complete %s settlement without marking model facts changed",
    (kind) => {
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
        expect(events).not.toHaveBeenCalled();
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
          { phase: "catalog-published", modelFactsChanged: false },
          { phase: "catalog-published", modelFactsChanged: false, refreshStatusChanged: true },
          { phase: "catalog-published", modelFactsChanged: false },
          { phase: "catalog-published", modelFactsChanged: false, refreshStatusChanged: true },
          { phase: "catalog-published", modelFactsChanged: false },
        ]);
      } finally {
        unregister();
      }
    },
  );
});
