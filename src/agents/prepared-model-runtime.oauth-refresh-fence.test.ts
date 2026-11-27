// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";

import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
} from "./auth-profiles/oauth-refresh-marker.js";
import type { AuthProfileStore, OAuthCredential } from "./auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { setPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const { createMockSubsystemLogger } = await import("../../test/helpers/mock-subsystem-logger.js");
  return {
    ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
    createSubsystemLogger: (subsystem: string) =>
      createMockSubsystemLogger(subsystem, {
        warn: (...args) => getPreparedModelRuntimeMocks().warn(...args),
      }),
  };
});

const fixture = usePreparedModelRuntimeHarness(undefined, () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const { mocks } = fixture;

const provider = "acct-oauth";
const profileId = `${provider}:user@example.test`;
const model = `${provider}/account-only`;
const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
const options = { gatewayLifecycle: true, catalogMode: "static" as const };

function signedIn(generation: string, email = "user@example.test"): OAuthCredential {
  return {
    type: "oauth",
    provider,
    access: `${generation}-access`,
    refresh: `${generation}-refresh`,
    expires: Date.now() + 3_600_000,
    email,
  };
}

/** Publish the auth facts a real build reads: the store and the usable credential map. */
function useAuth(credential: OAuthCredential) {
  const store: AuthProfileStore = { version: 1, profiles: { [profileId]: credential } };
  mocks.preparedAuthStore = store;
  // Refresh fences are inert markers, so the usable credential map omits them.
  const usable: AuthStorageData =
    credential.expires === 1
      ? {}
      : {
          [provider]: {
            type: "oauth",
            access: credential.access,
            refresh: credential.refresh,
            expires: credential.expires,
          },
        };
  mocks.authStorage.getAll.mockReturnValue(usable);
  return { store, usable };
}

async function publishSignedInAccount(original: OAuthCredential) {
  mocks.configuredAgentIds = ["pro"];
  useAuth(original);
  const listings: string[] = [];
  mocks.runPreparedModelCatalogWorker.mockImplementation(async () => {
    const auth = useAuth(mocks.preparedAuthStore!.profiles[profileId] as OAuthCredential);
    // Like a sign-in plugin, discovery lists this account's models only for a usable
    // sign-in; without one it returns no live list (the provider ships no such row).
    const credential = auth.store.profiles[profileId] as OAuthCredential;
    const listing = Object.keys(auth.usable).length > 0 ? `listed:${credential.email}` : "none";
    listings.push(listing);
    const catalog: ModelCatalogSnapshot =
      listing === "none"
        ? { entries: [], routeVariants: [] }
        : {
            entries: [{ provider, id: "account-only", name: "Account only" }],
            routeVariants: [],
            providerOutcomes: [{ provider, profileId, status: "ready" }],
          };
    setPreparedModelFullCatalogAuth(catalog, {
      providerAuthLabels: new Map(),
      authStore: auth.store,
      authModes: listing === "none" ? {} : { [provider]: "oauth" },
      credentials: auth.usable,
    });
    return catalog;
  });
  await refreshPreparedModelRuntimeSnapshots(config, options);
  const initial = await prepareModelRuntimeSnapshot(fixture.agentInput("pro", config));
  await initial.loadFullModelCatalog!({ refresh: true, wait: true });
  expect(modelIds(initial)).toEqual([model]);
  listings.length = 0;
  return listings;
}

/** A rebuild that runs while the store holds the given credential. */
async function rebuildWith(credential: OAuthCredential, trigger: "reload" | "auth" = "reload") {
  useAuth(credential);
  if (trigger === "auth") {
    // The refresh owner's shared-store write: every inheriting owner rebuilds.
    const published = new Promise<void>((resolve, reject) => {
      const dispose = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "published" || event.phase === "failed") {
          dispose();
          if (event.phase === "failed") {
            reject(event.error);
          } else {
            resolve();
          }
        }
      });
    });
    mocks.mutationListener?.({ affectsInheritedStores: true, profileSetChanged: false });
    await published;
  } else {
    // A config reload republishes every configured owner from the current auth store.
    await refreshPreparedModelRuntimeSnapshots(config, options);
  }
  const snapshot = await prepareModelRuntimeSnapshot(fixture.agentInput("pro", config));
  // Publication starts its changed-provider reacquisition after commit; let it settle.
  await snapshot.loadFullModelCatalog!({ changedOnly: true, wait: true });
  return snapshot;
}

function modelIds(snapshot: Awaited<ReturnType<typeof prepareModelRuntimeSnapshot>>) {
  return snapshot.readFullModelCatalog!()?.entries.map(
    ({ provider: owner, id }) => `${owner}/${id}`,
  );
}

describe("account catalog across an OAuth refresh", () => {
  it.for(["auth", "reload"] as const)(
    "keeps the account's models when a %s rebuild reads the in-flight refresh claim",
    async (trigger) => {
      const original = signedIn("first");
      const listings = await publishSignedInAccount(original);

      // The refresh owner first replaces the credential with its pending claim, and that write
      // publishes an auth mutation, so a rebuild can run inside the refresh window.
      const fenced = await rebuildWith(
        createOAuthRefreshFence({ profileId, credential: original }),
        trigger,
      );
      // Turns resolve the session model against this catalog; a missing row is reported as
      // "This model was not found". The settle-time rebuild can be superseded, so this
      // generation can stay published until the Gateway restarts.
      expect(modelIds(fenced)).toEqual([model]);
      // The account was never signed out, so discovery must not relist without it.
      expect(listings).toEqual([]);

      // Settling the claim with rotated tokens for the same account keeps the rows.
      const settled = await rebuildWith(signedIn("second"), trigger);
      expect(modelIds(settled)).toEqual([model]);
      expect(listings).toEqual([]);
    },
  );

  it("still drops the account's live inventory once the refresh claim fails", async () => {
    const original = signedIn("first");
    const listings = await publishSignedInAccount(original);
    const failed = createFailedOAuthRefreshFence(
      createOAuthRefreshFence({ profileId, credential: original }),
    );
    const ended = await rebuildWith(failed);
    // An ended sign-in no longer proves the account, so discovery runs without it.
    expect(listings).toEqual(["none"]);
    expect(modelIds(ended)).toEqual([]);
  });

  it("relists when the claim settles to a different account", async () => {
    const original = signedIn("first");
    const listings = await publishSignedInAccount(original);
    await rebuildWith(createOAuthRefreshFence({ profileId, credential: original }));
    const other = await rebuildWith(signedIn("other", "other@example.test"));
    // Retention follows the account identity, not just the profile id.
    expect(listings).toEqual(["listed:other@example.test"]);
    expect(modelIds(other)).toEqual([model]);
  });
});
