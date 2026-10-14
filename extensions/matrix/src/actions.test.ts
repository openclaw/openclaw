// Matrix tests cover actions plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { matrixMessageActions } from "./actions.js";
import type { MatrixCredentialStateRecord } from "./matrix/credentials-state.js";
import { setMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const lookupStoredCredentials = vi.fn<() => Promise<MatrixCredentialStateRecord | undefined>>();

const runtimeStub = {
  config: {
    current: () => ({}),
  },
  state: {
    resolveStateDir: () => "/tmp/openclaw-matrix-test",
    openKeyedStoreV2: () => ({ lookup: lookupStoredCredentials }),
  },
} as unknown as PluginRuntime;

function createConfiguredMatrixConfig(): CoreConfig {
  return {
    channels: {
      matrix: {
        enabled: true,
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "token",
      },
    },
  } as CoreConfig;
}

describe("matrixMessageActions", () => {
  beforeEach(() => {
    lookupStoredCredentials.mockReset().mockResolvedValue(undefined);
    setMatrixRuntime(runtimeStub);
  });

  it("discovers saved-login actions and schema after credential preparation", async () => {
    const credentials = Promise.withResolvers<MatrixCredentialStateRecord | undefined>();
    lookupStoredCredentials.mockReturnValue(credentials.promise);
    const discovery = matrixMessageActions.describeMessageToolAsync!({
      cfg: {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            encryption: true,
          },
        },
      },
      senderIsOwner: true,
    });
    credentials.resolve({
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "stored-token",
      createdAt: "2026-03-19T00:00:00.000Z",
    });

    const resolved = await discovery;
    expect(resolved?.actions).toEqual(
      expect.arrayContaining(["send", "react", "set-profile", "permissions"]),
    );
    expect(resolved?.capabilities).toEqual(["presentation"]);
    expect(resolved?.mediaSourceParams).toEqual({ "set-profile": ["avatarUrl", "avatarPath"] });
    const schemas = Array.isArray(resolved?.schema) ? resolved.schema : [resolved?.schema];
    expect(
      schemas.find((schema) => schema?.actions?.includes("set-profile"))?.properties,
    ).toHaveProperty("avatarUrl");
  });

  it("advertises custom-emote discovery and its reaction hint only when reactions are enabled", () => {
    const cfg = createConfiguredMatrixConfig();
    const enabled = matrixMessageActions.describeMessageTool({ cfg } as never);
    const disabled = matrixMessageActions.describeMessageTool({
      cfg: {
        channels: {
          matrix: { ...cfg.channels?.matrix, actions: { reactions: false } },
        },
      },
    } as never);

    expect(enabled?.actions).toContain("emoji-list");
    expect(matrixMessageActions.supportsAction?.({ action: "emoji-list" } as never)).toBe(true);
    expect(enabled?.schema).toMatchObject({
      actions: ["react", "reactions"],
      properties: {
        emoji: {
          description: expect.stringContaining('action:"emoji-list"'),
        },
      },
    });
    expect(disabled?.actions).not.toContain("emoji-list");
    expect(disabled?.actions).not.toContain("react");
    expect(disabled?.schema).toBeNull();
  });

  it("hides actions until defaultAccount is set for ambiguous multi-account configs", () => {
    const discovery = matrixMessageActions.describeMessageTool({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              assistant: {
                homeserver: "https://matrix.example.org",
                accessToken: "assistant-token",
              },
              ops: {
                homeserver: "https://matrix.example.org",
                accessToken: "ops-token",
              },
            },
          },
        },
      } as CoreConfig,
    } as never);
    if (!discovery) {
      throw new Error("describeMessageTool returned null");
    }
    const actions = discovery.actions;

    expect(actions).toStrictEqual([]);
    expect(discovery.capabilities).toStrictEqual([]);
  });
});
