import type { ChannelMessageToolDiscovery } from "openclaw/plugin-sdk/channel-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { matrixMessageActions } from "./actions.js";
import type { MatrixCredentialStateRecord } from "./matrix/credentials-state.js";
import { setMatrixRuntime } from "./runtime.js";
import type { CoreConfig, MatrixConfig } from "./types.js";

const lookupStoredCredentials = vi.fn<() => Promise<MatrixCredentialStateRecord | undefined>>();

const runtimeStub = {
  config: { current: () => ({}) },
  state: {
    resolveStateDir: () => "/tmp/openclaw-matrix-test",
    openKeyedStoreV2: () => ({ lookup: lookupStoredCredentials }),
  },
} as unknown as PluginRuntime;

function matrixConfig(overrides: Partial<MatrixConfig> = {}): CoreConfig {
  return {
    channels: {
      matrix: {
        enabled: true,
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "token",
        ...overrides,
      },
    },
  };
}

function discover(overrides: Partial<MatrixConfig> = {}) {
  return matrixMessageActions.describeMessageTool({ cfg: matrixConfig(overrides) } as never);
}

function listSchemas(schema: ChannelMessageToolDiscovery["schema"] | undefined) {
  return Array.isArray(schema) ? schema : schema ? [schema] : [];
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
      cfg: matrixConfig({ enabled: undefined, accessToken: undefined, encryption: true }),
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
    expect(resolved).toMatchObject({
      actions: expect.arrayContaining(["send", "react", "set-profile", "permissions"]),
      capabilities: ["presentation"],
      mediaSourceParams: { "set-profile": ["avatarUrl", "avatarPath"] },
    });
    const schemas = listSchemas(resolved?.schema);
    expect(
      schemas.find((schema) => schema?.actions?.includes("set-profile"))?.properties,
    ).toHaveProperty("avatarUrl");
  });

  it("advertises custom-emote discovery and its reaction hint only when reactions are enabled", () => {
    const enabled = discover();
    const disabled = discover({ actions: { reactions: false } });

    expect(enabled?.actions).toContain("emoji-list");
    expect(matrixMessageActions.supportsAction?.({ action: "emoji-list" } as never)).toBe(true);
    expect(listSchemas(enabled?.schema)).toContainEqual({
      actions: ["react", "reactions"],
      properties: {
        emoji: expect.objectContaining({
          description: expect.stringContaining('action:"emoji-list"'),
        }),
      },
    });
    expect(disabled?.actions).not.toContain("emoji-list");
    expect(disabled?.actions).not.toContain("react");
    expect(listSchemas(disabled?.schema).some((schema) => "emoji" in schema.properties)).toBe(
      false,
    );
  });

  it("adds metadata-only pagination-token guidance for read cursors", () => {
    const enabled = discover();
    const readDisabled = discover({ actions: { messages: false } });

    const cursor = expect.objectContaining({
      description: expect.stringContaining("nextBatch/prevBatch, not an event id"),
    });
    expect(listSchemas(enabled?.schema)).toContainEqual({
      actions: [],
      properties: { before: cursor, after: cursor },
    });
    expect(readDisabled?.actions).not.toContain("read");
    expect(listSchemas(readDisabled?.schema).some((schema) => "before" in schema.properties)).toBe(
      false,
    );
  });

  it("hides actions until defaultAccount is set for ambiguous multi-account configs", () => {
    const account = { homeserver: "https://matrix.example.org", accessToken: "token" };
    const discovery = matrixMessageActions.describeMessageTool({
      cfg: { channels: { matrix: { accounts: { assistant: account, ops: account } } } },
    } as never);
    expect(discovery).toStrictEqual({ actions: [], capabilities: [] });
  });
});
