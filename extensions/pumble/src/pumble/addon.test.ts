import { describe, expect, it, vi } from "vitest";
import type { ResolvedPumbleAccount } from "./accounts.js";
import { buildPumbleManifest } from "./addon.js";

function makeAccount(overrides: Partial<ResolvedPumbleAccount> = {}): ResolvedPumbleAccount {
  return {
    accountId: "default",
    enabled: true,
    appId: "app-123",
    appKey: "key-456",
    clientSecret: "secret-789",
    signingSecret: "sig-abc",
    botToken: "xoxb-test",
    workspaceId: "ws-1",
    appIdSource: "config",
    config: {},
    ...overrides,
  };
}

describe("buildPumbleManifest", () => {
  it("produces a valid manifest from account config", () => {
    const manifest = buildPumbleManifest(makeAccount());
    expect(manifest.id).toBe("app-123");
    expect(manifest.appKey).toBe("key-456");
    expect(manifest.clientSecret).toBe("secret-789");
    expect(manifest.signingSecret).toBe("sig-abc");
    expect(manifest.socketMode).toBe(false);
    expect(manifest.shortcuts).toEqual([]);
    expect(manifest.slashCommands).toEqual([]);
    expect(manifest.dynamicMenus).toEqual([]);
    expect(manifest.redirectUrls).toEqual([]);
    expect(manifest.scopes.botScopes).toContain("messages:read");
    expect(manifest.scopes.botScopes).toContain("messages:write");
    expect(manifest.scopes.userScopes).toEqual([]);
    expect(manifest.eventSubscriptions.events).toContain("NEW_MESSAGE");
  });

  it("sets webhook URLs when webhookBaseUrl is provided", () => {
    const manifest = buildPumbleManifest(makeAccount(), "https://example.loca.lt");
    expect(manifest.socketMode).toBe(false);
    expect(manifest.eventSubscriptions.url).toBe("https://example.loca.lt/hook");
    expect(manifest.redirectUrls).toEqual(["https://example.loca.lt/redirect"]);
  });

  it("strips trailing slashes from webhookBaseUrl", () => {
    const manifest = buildPumbleManifest(makeAccount(), "https://example.loca.lt///");
    expect(manifest.eventSubscriptions.url).toBe("https://example.loca.lt/hook");
    expect(manifest.redirectUrls).toEqual(["https://example.loca.lt/redirect"]);
  });

  it("trims whitespace from credential fields", () => {
    const manifest = buildPumbleManifest(
      makeAccount({
        appId: "  app-trimmed  ",
        appKey: "  key-trimmed  ",
        clientSecret: "  secret-trimmed  ",
        signingSecret: "  sig-trimmed  ",
      }),
    );
    expect(manifest.id).toBe("app-trimmed");
    expect(manifest.appKey).toBe("key-trimmed");
    expect(manifest.clientSecret).toBe("secret-trimmed");
    expect(manifest.signingSecret).toBe("sig-trimmed");
  });

  it("throws when appId is missing", () => {
    expect(() => buildPumbleManifest(makeAccount({ appId: undefined }))).toThrow(
      "appId is required",
    );
  });

  it("throws when appId is empty string", () => {
    expect(() => buildPumbleManifest(makeAccount({ appId: "  " }))).toThrow("appId is required");
  });

  it("throws when appKey is missing", () => {
    expect(() => buildPumbleManifest(makeAccount({ appKey: undefined }))).toThrow(
      "appKey is required",
    );
  });

  it("throws when clientSecret is missing", () => {
    expect(() => buildPumbleManifest(makeAccount({ clientSecret: undefined }))).toThrow(
      "clientSecret is required",
    );
  });

  it("throws when signingSecret is missing", () => {
    expect(() => buildPumbleManifest(makeAccount({ signingSecret: undefined }))).toThrow(
      "signingSecret is required",
    );
  });
});

describe("createPumbleAddon", () => {
  it("returns an Addon instance with HTTP mode and correct port", async () => {
    // Mock the pumble-sdk setup function to avoid real SDK initialization
    vi.doMock("pumble-sdk", () => ({
      setup: vi.fn((manifest: Record<string, unknown>, options: Record<string, unknown>) => ({
        getManifest: () => manifest,
        getOptions: () => options,
        message: vi.fn().mockReturnThis(),
        onError: vi.fn().mockReturnThis(),
        start: vi.fn(),
      })),
    }));

    const { createPumbleAddon } = await import("./addon.js");
    const store = {
      initialize: vi.fn(),
      getBotToken: vi.fn(),
      getUserToken: vi.fn(),
      getBotUserId: vi.fn(),
      saveTokens: vi.fn(),
      deleteForWorkspace: vi.fn(),
      deleteForUser: vi.fn(),
    };

    const addon = createPumbleAddon(makeAccount(), store, {
      webhookBaseUrl: "https://test.loca.lt",
      port: 3000,
    });
    expect(addon).toBeDefined();
    expect(addon.getManifest().id).toBe("app-123");
    expect(addon.getManifest().socketMode).toBe(false);
    expect(addon.getManifest().eventSubscriptions.url).toBe("https://test.loca.lt/hook");

    vi.doUnmock("pumble-sdk");
  });
});
