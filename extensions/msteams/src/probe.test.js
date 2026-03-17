import { describe, expect, it, vi } from "vitest";
const hostMockState = vi.hoisted(() => ({
  tokenError: null
}));
vi.mock("@microsoft/agents-hosting", () => ({
  getAuthConfigWithDefaults: (cfg) => cfg,
  MsalTokenProvider: class {
    async getAccessToken() {
      if (hostMockState.tokenError) {
        throw hostMockState.tokenError;
      }
      return "token";
    }
  }
}));
import { probeMSTeams } from "./probe.js";
describe("msteams probe", () => {
  it("returns an error when credentials are missing", async () => {
    const cfg = { enabled: true };
    await expect(probeMSTeams(cfg)).resolves.toMatchObject({
      ok: false
    });
  });
  it("validates credentials by acquiring a token", async () => {
    hostMockState.tokenError = null;
    const cfg = {
      enabled: true,
      appId: "app",
      appPassword: "pw",
      tenantId: "tenant"
    };
    await expect(probeMSTeams(cfg)).resolves.toMatchObject({
      ok: true,
      appId: "app"
    });
  });
  it("returns a helpful error when token acquisition fails", async () => {
    hostMockState.tokenError = new Error("bad creds");
    const cfg = {
      enabled: true,
      appId: "app",
      appPassword: "pw",
      tenantId: "tenant"
    };
    await expect(probeMSTeams(cfg)).resolves.toMatchObject({
      ok: false,
      appId: "app",
      error: "bad creds"
    });
  });
});
