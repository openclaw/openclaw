import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthProfileOrder } from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles.js";

const listRuntimeOnlyExternalAuthProfilesMock = vi.hoisted(() =>
  vi.fn<
    (params: unknown) => Array<{ profileId: string; selectionPriority: "default" | "highest" }>
  >(() => []),
);

vi.mock("./auth-profiles/external-auth.js", () => ({
  listRuntimeOnlyExternalAuthProfiles: (params: unknown) =>
    listRuntimeOnlyExternalAuthProfilesMock(params),
}));

function createStore(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    version: 1,
    profiles,
  };
}

describe("resolveAuthProfileOrder runtime-only external profiles", () => {
  beforeEach(() => {
    listRuntimeOnlyExternalAuthProfilesMock.mockReset();
  });

  it("appends runtime-only external profiles after configured profile ids", () => {
    listRuntimeOnlyExternalAuthProfilesMock.mockReturnValueOnce([
      { profileId: "zai:runtime-env-1", selectionPriority: "default" },
    ]);

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          profiles: {
            "zai:default": {
              provider: "zai",
              mode: "api_key",
            },
          },
        },
      },
      store: createStore({
        "zai:default": {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-default",
        },
        "zai:runtime-env-1": {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-runtime",
        },
      }),
      provider: "zai",
    });

    expect(order).toEqual(["zai:default", "zai:runtime-env-1"]);
  });

  it("appends runtime-only external profiles after explicit order entries", () => {
    listRuntimeOnlyExternalAuthProfilesMock.mockReturnValueOnce([
      { profileId: "zai:runtime-env-1", selectionPriority: "default" },
    ]);

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            zai: ["zai:work", "zai:default"],
          },
          profiles: {
            "zai:default": {
              provider: "zai",
              mode: "api_key",
            },
            "zai:work": {
              provider: "zai",
              mode: "api_key",
            },
          },
        },
      },
      store: createStore({
        "zai:default": {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-default",
        },
        "zai:work": {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-work",
        },
        "zai:runtime-env-1": {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-runtime",
        },
      }),
      provider: "zai",
    });

    expect(order).toEqual(["zai:work", "zai:default", "zai:runtime-env-1"]);
  });

  it("prioritizes highest-priority runtime-only external profiles ahead of configured ids", () => {
    listRuntimeOnlyExternalAuthProfilesMock.mockReturnValueOnce([
      { profileId: "zai:runtime-live-override", selectionPriority: "highest" },
    ]);

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          profiles: {
            "zai:default": {
              provider: "zai",
              mode: "api_key",
            },
          },
        },
      },
      store: createStore({
        "zai:default": {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-default",
        },
        "zai:runtime-live-override": {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-live",
        },
      }),
      provider: "zai",
    });

    expect(order).toEqual(["zai:runtime-live-override", "zai:default"]);
  });

  it("prioritizes highest-priority runtime-only external profiles without explicit config", () => {
    listRuntimeOnlyExternalAuthProfilesMock.mockReturnValueOnce([
      { profileId: "zai:runtime-live-override", selectionPriority: "highest" },
    ]);

    const order = resolveAuthProfileOrder({
      store: createStore({
        "zai:default": {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-default",
        },
        "zai:runtime-live-override": {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-live",
        },
      }),
      provider: "zai",
    });

    expect(order).toEqual(["zai:runtime-live-override", "zai:default"]);
  });

  it("keeps highest-priority runtime-only external profiles behind available profiles when cooled down", () => {
    listRuntimeOnlyExternalAuthProfilesMock.mockReturnValueOnce([
      { profileId: "zai:runtime-live-override", selectionPriority: "highest" },
    ]);

    const order = resolveAuthProfileOrder({
      store: {
        version: 1,
        profiles: {
          "zai:default": {
            type: "api_key",
            provider: "zai",
            key: "sk-zai-default",
          },
          "zai:runtime-live-override": {
            type: "api_key",
            provider: "zai",
            key: "sk-zai-live",
          },
        },
        usageStats: {
          "zai:runtime-live-override": {
            cooldownUntil: Date.now() + 60_000,
          },
        },
      },
      provider: "zai",
    });

    expect(order).toEqual(["zai:default", "zai:runtime-live-override"]);
  });

  it("keeps cooled-down highest-priority runtime-only external profiles behind available profiles in explicit order mode", () => {
    listRuntimeOnlyExternalAuthProfilesMock.mockReturnValueOnce([
      { profileId: "zai:runtime-live-override", selectionPriority: "highest" },
    ]);

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            zai: ["zai:default", "zai:runtime-live-override"],
          },
          profiles: {
            "zai:default": {
              provider: "zai",
              mode: "api_key",
            },
            "zai:runtime-live-override": {
              provider: "zai",
              mode: "api_key",
            },
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "zai:default": {
            type: "api_key",
            provider: "zai",
            key: "sk-zai-default",
          },
          "zai:runtime-live-override": {
            type: "api_key",
            provider: "zai",
            key: "sk-zai-live",
          },
        },
        usageStats: {
          "zai:runtime-live-override": {
            cooldownUntil: Date.now() + 60_000,
          },
        },
      },
      provider: "zai",
    });

    expect(order).toEqual(["zai:default", "zai:runtime-live-override"]);
  });

  it("repairs stale configured profile ids even when a runtime-only overlay is present", () => {
    listRuntimeOnlyExternalAuthProfilesMock.mockReturnValueOnce([
      { profileId: "openai-codex:runtime-env-1", selectionPriority: "default" },
    ]);

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          profiles: {
            "openai-codex:default": {
              provider: "openai-codex",
              mode: "oauth",
            },
          },
          order: {
            "openai-codex": ["openai-codex:default"],
          },
        },
      },
      store: createStore({
        "openai-codex:user@example.com": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
        "openai-codex:runtime-env-1": {
          type: "api_key",
          provider: "openai-codex",
          key: "sk-openai-runtime",
        },
      }),
      provider: "openai-codex",
    });

    expect(order).toEqual(["openai-codex:runtime-env-1", "openai-codex:user@example.com"]);
  });
});
