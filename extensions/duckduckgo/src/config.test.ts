import { describe, expect, it } from "vitest";
import {
  resolveDdgRegion,
  resolveDdgSafeSearch,
  resolveDdgSearchTimeoutSeconds,
  DEFAULT_DDG_SEARCH_TIMEOUT_SECONDS,
} from "./config.js";

describe("resolveDdgRegion", () => {
  it("returns undefined when no config", () => {
    expect(resolveDdgRegion(undefined)).toBeUndefined();
    expect(resolveDdgRegion({})).toBeUndefined();
  });

  it("returns configured region", () => {
    const cfg = {
      plugins: {
        entries: {
          duckduckgo: { config: { webSearch: { region: "br-pt" } } },
        },
      },
    };
    expect(resolveDdgRegion(cfg)).toBe("br-pt");
  });

  it("returns undefined for empty string region", () => {
    const cfg = {
      plugins: {
        entries: {
          duckduckgo: { config: { webSearch: { region: "  " } } },
        },
      },
    };
    expect(resolveDdgRegion(cfg)).toBeUndefined();
  });
});

describe("resolveDdgSafeSearch", () => {
  it("defaults to moderate", () => {
    expect(resolveDdgSafeSearch(undefined)).toBe("moderate");
    expect(resolveDdgSafeSearch({})).toBe("moderate");
  });

  it("accepts strict", () => {
    const cfg = {
      plugins: {
        entries: {
          duckduckgo: { config: { webSearch: { safeSearch: "strict" } } },
        },
      },
    };
    expect(resolveDdgSafeSearch(cfg)).toBe("strict");
  });

  it("accepts off", () => {
    const cfg = {
      plugins: {
        entries: {
          duckduckgo: { config: { webSearch: { safeSearch: "off" } } },
        },
      },
    };
    expect(resolveDdgSafeSearch(cfg)).toBe("off");
  });

  it("falls back to moderate for unknown values", () => {
    const cfg = {
      plugins: {
        entries: {
          duckduckgo: { config: { webSearch: { safeSearch: "invalid" } } },
        },
      },
    };
    expect(resolveDdgSafeSearch(cfg)).toBe("moderate");
  });
});

describe("resolveDdgSearchTimeoutSeconds", () => {
  it("returns default when no override", () => {
    expect(resolveDdgSearchTimeoutSeconds(undefined)).toBe(
      DEFAULT_DDG_SEARCH_TIMEOUT_SECONDS,
    );
  });

  it("returns override when valid", () => {
    expect(resolveDdgSearchTimeoutSeconds(15)).toBe(15);
  });

  it("ignores invalid overrides", () => {
    expect(resolveDdgSearchTimeoutSeconds(0)).toBe(
      DEFAULT_DDG_SEARCH_TIMEOUT_SECONDS,
    );
    expect(resolveDdgSearchTimeoutSeconds(-5)).toBe(
      DEFAULT_DDG_SEARCH_TIMEOUT_SECONDS,
    );
    expect(resolveDdgSearchTimeoutSeconds(NaN)).toBe(
      DEFAULT_DDG_SEARCH_TIMEOUT_SECONDS,
    );
  });
});
