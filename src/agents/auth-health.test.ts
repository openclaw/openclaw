import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
} from "./auth-health.js";

describe("buildAuthHealthSummary", () => {
  const now = 1_700_000_000_000;
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies OAuth and API key profiles", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "anthropic:ok": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now + DEFAULT_OAUTH_WARN_MS + 60_000,
        },
        "anthropic:expiring": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now + 10_000,
        },
        "anthropic:expired": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now - 10_000,
        },
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant-api",
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const statuses = Object.fromEntries(
      summary.profiles.map((profile) => [profile.profileId, profile.status]),
    );

    expect(statuses["anthropic:ok"]).toBe("ok");
    expect(statuses["anthropic:expiring"]).toBe("expiring");
    expect(statuses["anthropic:expired"]).toBe("expired");
    expect(statuses["anthropic:api"]).toBe("static");

    const provider = summary.providers.find(
      (entry) => entry.provider === "anthropic",
    );
    expect(provider?.status).toBe("expired");
  });
});
