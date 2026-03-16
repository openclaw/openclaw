import { describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";
import qwenPortalPlugin from "./index.js";

const refreshQwenPortalCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/providers/qwen-portal-oauth.js", () => ({
  refreshQwenPortalCredentials: refreshQwenPortalCredentialsMock,
}));

describe("qwen portal plugin", () => {
  it("owns OAuth refresh", async () => {
    const provider = registerSingleProviderPlugin(qwenPortalPlugin);
    const credential = {
      type: "oauth" as const,
      provider: "qwen-portal",
      access: "stale-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    };
    const refreshed = {
      ...credential,
      access: "fresh-access-token",
      expires: Date.now() + 60_000,
    };

    refreshQwenPortalCredentialsMock.mockReset();
    refreshQwenPortalCredentialsMock.mockResolvedValueOnce(refreshed);

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(refreshed);
  });
});
