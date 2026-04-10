import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthProfileOrder } from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles.js";

const listRuntimeOnlyExternalAuthProfileIdsMock = vi.hoisted(() =>
  vi.fn<(params: unknown) => string[]>(() => []),
);

vi.mock("./auth-profiles/external-auth.js", () => ({
  listRuntimeOnlyExternalAuthProfileIds: (params: unknown) =>
    listRuntimeOnlyExternalAuthProfileIdsMock(params),
}));

function createStore(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    version: 1,
    profiles,
  };
}

describe("resolveAuthProfileOrder runtime-only external profiles", () => {
  beforeEach(() => {
    listRuntimeOnlyExternalAuthProfileIdsMock.mockReset();
  });

  it("appends runtime-only external profiles after configured profile ids", () => {
    listRuntimeOnlyExternalAuthProfileIdsMock.mockReturnValueOnce(["zai:runtime-env-1"]);

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
    listRuntimeOnlyExternalAuthProfileIdsMock.mockReturnValueOnce(["zai:runtime-env-1"]);

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
});
