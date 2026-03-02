import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
} from "./auth-health.js";

describe("buildAuthHealthSummary", () => {
  const now = 1_700_000_000_000;
  const profileStatuses = (summary: ReturnType<typeof buildAuthHealthSummary>) =>
    Object.fromEntries(summary.profiles.map((profile) => [profile.profileId, profile.status]));

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

    const statuses = profileStatuses(summary);

    expect(statuses["anthropic:ok"]).toBe("ok");
    // OAuth credentials with refresh tokens are auto-renewable, so they report "ok"
    expect(statuses["anthropic:expiring"]).toBe("ok");
    expect(statuses["anthropic:expired"]).toBe("ok");
    expect(statuses["anthropic:api"]).toBe("static");

    const provider = summary.providers.find((entry) => entry.provider === "anthropic");
    expect(provider?.status).toBe("ok");
  });

  it("reports expired for OAuth without a refresh token", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "google:no-refresh": {
          type: "oauth" as const,
          provider: "google-antigravity",
          access: "access",
          refresh: "",
          expires: now - 10_000,
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const statuses = profileStatuses(summary);

    expect(statuses["google:no-refresh"]).toBe("expired");
  });
});

describe("formatRemainingShort", () => {
  it("supports an explicit under-minute label override", () => {
    expect(formatRemainingShort(20_000)).toBe("1m");
    expect(formatRemainingShort(20_000, { underMinuteLabel: "soon" })).toBe("soon");
  });
});
