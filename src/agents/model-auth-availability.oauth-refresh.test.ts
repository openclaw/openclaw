import { describe, expect, it, vi } from "vitest";
import { createOAuthRefreshAuthority } from "./model-auth-availability.oauth-refresh.js";

describe("createOAuthRefreshAuthority", () => {
  it("keeps core OpenAI and exact external CLI profiles refreshable", () => {
    const canRefresh = createOAuthRefreshAuthority([{ profileId: "cli:main" }], undefined);

    expect(canRefresh("openai", "openai:any")).toBe(true);
    expect(canRefresh("cli", "cli:main")).toBe(true);
    expect(canRefresh("cli", "cli:other")).toBe(false);
  });

  it("asks the provider plugin once per normalized provider", () => {
    const owns = vi.fn((provider: string) => provider.toLowerCase() === "acme");
    const canRefresh = createOAuthRefreshAuthority([], owns);

    expect(canRefresh("acme", "acme:a")).toBe(true);
    expect(canRefresh("ACME", "acme:b")).toBe(true);
    expect(canRefresh("other", "other:a")).toBe(false);
    expect(owns).toHaveBeenCalledTimes(2);
  });
});
