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

const auth = {
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "token",
};
function matrixConfig(overrides: Partial<MatrixConfig> = {}): CoreConfig {
  const matrix = { enabled: true, ...auth, ...overrides };
  return { channels: { matrix } };
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
      ...auth,
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
    expect(schemas.find((s) => s.actions?.includes("set-profile"))?.properties).toHaveProperty(
      "avatarUrl",
    );
  });

  it.each([
    ["reactions", ["emoji"], 'action:"emoji-list"'],
    ["messages", ["before", "after"], "nextBatch/prevBatch, not an event id"],
  ] as const)("gates %s actions and schema hints", (gate, keys, hint) => {
    const actions = gate === "reactions" ? (["emoji-list", "react"] as const) : (["read"] as const);
    const enabled = discover();
    const disabled = discover({ actions: { [gate]: false } });
    const property = expect.objectContaining({ description: expect.stringContaining(hint) });
    expect(listSchemas(enabled?.schema)).toContainEqual({
      actions: gate === "reactions" ? ["react", "reactions"] : [],
      properties: Object.fromEntries(keys.map((key) => [key, property])),
    });
    for (const action of actions) {
      expect(enabled?.actions).toContain(action);
      expect(disabled?.actions).not.toContain(action);
    }
    expect(listSchemas(disabled?.schema).some((s) => keys[0] in s.properties)).toBe(false);
    if (gate === "reactions") {
      expect(matrixMessageActions.supportsAction?.({ action: "emoji-list" } as never)).toBe(true);
    }
  });

  it("hides actions until defaultAccount is set for ambiguous multi-account configs", () => {
    const discovery = matrixMessageActions.describeMessageTool({
      cfg: { channels: { matrix: { accounts: { assistant: auth, ops: auth } } } },
    } as never);
    expect(discovery).toStrictEqual({ actions: [], capabilities: [] });
  });
});
