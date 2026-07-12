// Firecrawl config lookups — Object.hasOwn() defense-in-depth proof
//
// The config resolver uses Object.hasOwn() instead of the `in` operator for
// own-property field checks. This is defense-in-depth: `in` traverses the
// prototype chain, so any inherited property (regardless of source) could
// interfere with config lookups. Object.hasOwn() checks only the object's
// own properties, which is the correct check for a POJO config record.
//
// The production config loader (deepMerge in includes.ts) already blocks
// __proto__ keys at the merge boundary. This change adds defense at the
// resolver level so every config field lookup is independently safe
// regardless of how the object was constructed.
//
// Pre-Zod boundary: resolveFirecrawlSearchConfig and resolveFirecrawlFetchConfig
// run on the raw POJO config before Zod schema validation strips non-schema
// properties, so the resolver itself must be prototype-safe.

import { describe, test, expect } from "vitest";
import { resolveFirecrawlSearchConfig } from "./config.ts";

describe("Firecrawl config lookups — Object.hasOwn defense-in-depth", () => {
  test("[1] Object.hasOwn checks only own properties, `in` follows prototype", () => {
    const proto = Object.create({ firecrawl: { apiKey: "INHERITED" } });
    const own = { firecrawl: { apiKey: "OWN" } };

    expect("firecrawl" in proto).toBe(true);
    expect("firecrawl" in own).toBe(true);
    expect(Object.hasOwn(proto, "firecrawl")).toBe(false);
    expect(Object.hasOwn(own, "firecrawl")).toBe(true);
  });

  test("[2] Proto-inherited firecrawl reaches resolveFirecrawlSearchConfig", () => {
    const pollutedSearch = Object.create({ firecrawl: { apiKey: "INHERITED" } });
    const cfg = { tools: { web: { search: pollutedSearch } } };

    expect("firecrawl" in pollutedSearch).toBe(true);
    const result = resolveFirecrawlSearchConfig(cfg as never);
    expect(result).toBeUndefined();
  });

  test("[3] Own firecrawl config still works (backward compat)", () => {
    const cfg = {
      tools: { web: { search: { firecrawl: { apiKey: "sk-valid-key" } } } },
    };
    const result = resolveFirecrawlSearchConfig(cfg as never);
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>).apiKey).toBe("sk-valid-key");
  });

  test("[4] Empty tools.web.search — no false positive", () => {
    expect(
      resolveFirecrawlSearchConfig({ tools: { web: { search: {} } } } as never),
    ).toBeUndefined();
  });

  test("[5] No tools.web.search — undefined input handled", () => {
    expect(resolveFirecrawlSearchConfig({} as never)).toBeUndefined();
  });

  test("[6] Object.assign with __proto__ property — defense layer", () => {
    // Object.assign copies own keys including __proto__ via [[Set]],
    // which triggers the __proto__ accessor and changes the prototype.
    // deepMerge blocks this via isBlockedObjectKey, but Object.assign
    // (used elsewhere in the codebase, e.g. defaults.ts) does not.
    // This is exactly the kind of path the defense-in-depth protects.
    const raw = JSON.parse(
      '{"apiKey":"env-fallback","__proto__":{"firecrawl":{"apiKey":"INHERITED"}}}',
    );
    const merged = Object.assign({}, raw);

    expect("firecrawl" in merged).toBe(true);
    expect(Object.hasOwn(merged, "firecrawl")).toBe(false);
  });
});
