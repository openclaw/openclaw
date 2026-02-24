import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import type { AuthProfileStore } from "./types.js";

function cfgFor(profileId: string, provider: string, mode: "api_key" | "token" | "oauth") {
  return {
    auth: {
      profiles: {
        [profileId]: { provider, mode },
      },
    },
  } satisfies OpenClawConfig;
}

function tokenStore(params: {
  profileId: string;
  provider: string;
  token: string;
  expires?: number;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "token",
        provider: params.provider,
        token: params.token,
        ...(params.expires !== undefined ? { expires: params.expires } : {}),
      },
    },
  };
}

async function resolveWithConfig(params: {
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  store: AuthProfileStore;
}) {
  return resolveApiKeyForProfile({
    cfg: cfgFor(params.profileId, params.provider, params.mode),
    store: params.store,
    profileId: params.profileId,
  });
}

describe("resolveApiKeyForProfile config compatibility", () => {
  it("accepts token credentials when config mode is oauth", async () => {
    const profileId = "anthropic:token";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "token",
          provider: "anthropic",
          token: "tok-123",
        },
      },
    };

    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "anthropic", "oauth"),
      store,
      profileId,
    });
    expect(result).toEqual({
      apiKey: "tok-123",
      provider: "anthropic",
      email: undefined,
    });
  });

  it("rejects token credentials when config mode is api_key", async () => {
    const profileId = "anthropic:token";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "api_key",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });

    expect(result).toBeNull();
  });

  it("rejects credentials when provider does not match config", async () => {
    const profileId = "anthropic:token";
    const result = await resolveWithConfig({
      profileId,
      provider: "openai",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });
    expect(result).toBeNull();
  });

  it("accepts oauth credentials when config mode is token (bidirectional compat)", async () => {
    const profileId = "anthropic:oauth";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "access-123",
          refresh: "refresh-123",
          expires: Date.now() + 60_000,
        },
      },
    };

    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "anthropic", "token"),
      store,
      profileId,
    });
    // token ↔ oauth are bidirectionally compatible bearer-token auth paths.
    expect(result).toEqual({
      apiKey: "access-123",
      provider: "anthropic",
      email: undefined,
    });
  });
});

describe("resolveApiKeyForProfile token expiry handling", () => {
  it("returns null for expired token credentials", async () => {
    const profileId = "anthropic:token-expired";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-expired",
        expires: Date.now() - 1_000,
      }),
    });
    expect(result).toBeNull();
  });

  it("accepts token credentials when expires is 0", async () => {
    const profileId = "anthropic:token-no-expiry";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
        expires: 0,
      }),
    });
    expect(result).toEqual({
      apiKey: "tok-123",
      provider: "anthropic",
      email: undefined,
    });
  });
});

describe("resolveApiKeyForProfile secret refs", () => {
  it("resolves api_key keyRef from env", async () => {
    const profileId = "openai:default";
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-ref";
    try {
      const result = await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "openai", "api_key"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", id: "OPENAI_API_KEY" },
            },
          },
        },
        profileId,
      });
      expect(result).toEqual({
        apiKey: "sk-openai-ref",
        provider: "openai",
        email: undefined,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("resolves token tokenRef from env", async () => {
    const profileId = "github-copilot:default";
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "gh-ref-token";
    try {
      const result = await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "github-copilot", "token"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "token",
              provider: "github-copilot",
              token: "",
              tokenRef: { source: "env", id: "GITHUB_TOKEN" },
            },
          },
        },
        profileId,
      });
      expect(result).toEqual({
        apiKey: "gh-ref-token",
        provider: "github-copilot",
        email: undefined,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previous;
      }
    }
  });
});
