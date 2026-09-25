import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  createCatalogAttemptReporter,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.publication-events.js";

describe("catalog attempt status publication", () => {
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
