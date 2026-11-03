import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential } from "./types.js";

const revision = vi.hoisted(() => ({ value: 1 }));
vi.mock("./runtime-snapshots.js", () => ({
  getRuntimeAuthProfileStoreCredentialsRevision: () => revision.value,
}));

const { getSetupCredentialRuntimeProfile, withSetupCredentialAccess } =
  await import("./setup-access.js");

const tokenRef = { source: "store", provider: "default", id: "SETUP_TOKEN" } as const;
const source: AuthProfileCredential = { type: "token", provider: "fixture", tokenRef };
const materialized: AuthProfileCredential = { ...source, token: "setup-token" };
const keyRef = { source: "store", provider: "default", id: "SETUP_KEY" } as const;
const keySource: AuthProfileCredential = { type: "api_key", provider: "fixture", keyRef };
const profileId = "fixture:setup";
const agentDir = "/agents/main/agent";

type Case = {
  name: string;
  source?: AuthProfileCredential;
  read?: { profileId?: string; agentDir?: string; profile?: AuthProfileCredential };
  mutate?: (abort: AbortController) => void;
  expected: "setup" | "global" | "revoked";
};

describe("getSetupCredentialRuntimeProfile", () => {
  beforeEach(() => {
    revision.value = 1;
  });

  it.each<Case>([
    { name: "persisted ref shape", expected: "setup" },
    {
      name: "ref overlaid with the global snapshot value",
      read: { profile: { ...source, token: "global-token" } },
      expected: "setup",
    },
    { name: "omitted agentDir", read: { agentDir: undefined }, expected: "global" },
    { name: "other agentDir", read: { agentDir: "/agents/other/agent" }, expected: "global" },
    { name: "other profile id", read: { profileId: "fixture:other" }, expected: "global" },
    {
      name: "changed source ref",
      read: { profile: { ...source, tokenRef: { ...tokenRef, id: "OTHER" }, token: "x" } },
      expected: "revoked",
    },
    {
      name: "changed metadata",
      read: { profile: { ...source, provider: "other", token: "x" } },
      expected: "revoked",
    },
    {
      name: "inline token without a ref",
      read: { profile: { type: "token", provider: "fixture", token: "x" } },
      expected: "revoked",
    },
    {
      name: "keyRef overlaid with the global snapshot value",
      source: keySource,
      read: { profile: { ...keySource, key: "global-key" } },
      expected: "setup",
    },
    {
      name: "changed keyRef",
      source: keySource,
      read: { profile: { ...keySource, keyRef: { ...keyRef, id: "OTHER" }, key: "x" } },
      expected: "revoked",
    },
    {
      name: "changed inline key without a ref",
      source: { type: "api_key", provider: "fixture", key: "setup-key" },
      read: { profile: { type: "api_key", provider: "fixture", key: "other-key" } },
      expected: "revoked",
    },
    { name: "aborted setup", mutate: (abort) => abort.abort(), expected: "revoked" },
    {
      name: "changed credentials revision",
      mutate: () => {
        revision.value = 2;
      },
      expected: "revoked",
    },
  ])("$name", async ({ source: owned = source, read, mutate, expected }) => {
    const abort = new AbortController();
    const result = await withSetupCredentialAccess(
      {
        profileId,
        agentDir,
        signal: abort.signal,
        runtimeCredential: { source: owned, materialized, credentialsRevision: 1 },
      },
      async () => {
        mutate?.(abort);
        return getSetupCredentialRuntimeProfile({
          profileId: read && "profileId" in read ? read.profileId! : profileId,
          agentDir: read && "agentDir" in read ? read.agentDir : agentDir,
          profile: read?.profile ?? owned,
        });
      },
    );
    expect(result).toEqual(
      expected === "setup" ? materialized : expected === "global" ? undefined : null,
    );
  });
});
