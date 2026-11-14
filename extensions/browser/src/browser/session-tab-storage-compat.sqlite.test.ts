import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { browserSessionTabStorageKey } from "./session-tab-identity.js";
import {
  clearProcessLocalTabState,
  installSessionTabRegistrySqliteHarness,
} from "./session-tab-registry.sqlite.test-harness.js";
import { readBrowserDashboardStopIntent, readBrowserDashboardTabs } from "./session-tab-store.js";

describe("browser persisted storage key compatibility", () => {
  const { openStore, installRuntime } = installSessionTabRegistrySqliteHarness();

  it("reopens native-crypto keyed tabs and stop intents without rewriting their keys", async () => {
    const identity = {
      sessionKey: "agent:main:unicode-🦞",
      agentId: "main",
      name: "café 🦞",
      instanceId: "instance-\u0301",
      url: "https://example.com/",
      profile: "remote",
    };
    const tab = {
      version: 1,
      sessionKey: identity.sessionKey,
      nativeTargetId: "NATIVE-🦞",
      profile: identity.profile,
      profileFingerprint: "profile-é",
      browserInstanceFingerprint: "browser-\u0301",
      interactionTargetKind: "native",
      trackedAt: 1000,
      lastUsedAt: 1000,
      dashboard: {
        name: identity.name,
        sessionKey: identity.sessionKey,
        instanceId: identity.instanceId,
        agentId: identity.agentId,
        url: identity.url,
        state: "active",
      },
    };
    const key = `sha256:${createHash("sha256")
      .update(
        JSON.stringify([
          tab.sessionKey,
          tab.nativeTargetId,
          tab.profileFingerprint,
          tab.browserInstanceFingerprint,
        ]),
      )
      .digest("hex")}`;
    const stopKey = `dashboard-stop:${createHash("sha256")
      .update(
        JSON.stringify([identity.sessionKey, identity.agentId, identity.instanceId, identity.name]),
      )
      .digest("hex")}`;
    const intent = {
      ...identity,
      kind: "dashboard-stop",
      version: 1,
      stopId: "bd5ce5eb-110a-46cc-b96a-a5756ea455f3",
    };
    openStore().register(key, tab);
    openStore().register(stopKey, intent);
    clearProcessLocalTabState();
    await installRuntime();

    expect(browserSessionTabStorageKey(tab)).toBe(key);
    expect(await readBrowserDashboardTabs()).toEqual([{ ...tab, storageKey: key }]);
    expect(await readBrowserDashboardStopIntent(identity)).toEqual(intent);
    expect(
      openStore()
        .entries()
        .map(({ key: storedKey }) => storedKey)
        .toSorted(),
    ).toEqual([key, stopKey].toSorted());
  });
});
