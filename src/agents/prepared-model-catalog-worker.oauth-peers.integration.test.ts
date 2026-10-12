import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { isPendingOAuthRefreshFence } from "./auth-profiles/oauth-refresh-marker.js";
import { PROVIDER_ID } from "./prepared-model-catalog-worker.test-support.js";
import { withHeldCatalogOAuthRefresh } from "./test-helpers/prepared-model-catalog-oauth-fixture.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();
const profileId = `${PROVIDER_ID}:oauth`;

it.for(["empty", "matching"] as const)(
  "refreshes shared OAuth from a real catalog worker with %s historical peers and empty agent databases",
  async (peers, { signal }) => {
    await withHeldCatalogOAuthRefresh(
      { makeTempDir, signal, sharedStatePeers: peers },
      async (fixture) => {
        await withinTest(fixture.waitForRefresh(), signal);
        const ownerFence = fixture.readCredential();
        expect(ownerFence?.type === "oauth" && isPendingOAuthRefreshFence(ownerFence)).toBe(true);
        if (peers === "matching") {
          expect(fixture.readPeerStore()?.profiles[profileId]).toEqual(ownerFence);
        }
        expect(fixture.readEmptyStore()).toBeNull();
        expect(fixture.refreshCalls()).toBe(1);

        expect(fixture.discoveryStarted()).toBe(true);
        fixture.releaseResponse();
        const result = await withinTest(fixture.pending, signal);
        expect(result.status).toBe("ok");
        if (result.status !== "ok" || result.kind !== "catalog") {
          throw new Error("Expected the real worker to finish catalog discovery");
        }
        expect(result.snapshot.entries).toContainEqual(
          expect.objectContaining({ provider: PROVIDER_ID, id: "oauth-model" }),
        );
        expect(fixture.readCredential()).toEqual(fixture.rotated);
        // The shared owner supplies the rotated credential; historical local copies are removed.
        expect(fixture.readPeerStore()?.profiles[profileId]).toBeUndefined();
        expect(fixture.readEmptyStore()).toBeNull();
        expect(fixture.refreshCalls()).toBe(1);
      },
    );
  },
);

it("rolls back shared and historical OAuth claims when a later peer blocks catalog refresh admission", async ({
  signal,
}) => {
  await withHeldCatalogOAuthRefresh(
    { makeTempDir, signal, sharedStatePeers: "conflicting" },
    async (fixture) => {
      const result = await withinTest(fixture.pending, signal);
      expect(result.status).not.toBe("generation-mismatch");
      expect(fixture.discoveryStarted()).toBe(true);
      expect(fixture.readRefreshFailure()).toContain("already claimed by another owner");
      if (result.status === "ok" && result.kind === "catalog") {
        expect(result.snapshot.entries).not.toContainEqual(
          expect.objectContaining({ provider: PROVIDER_ID, id: "oauth-model" }),
        );
      } else if (result.status === "failed") {
        expect(result.error).toMatch(/historical OAuth refresh peer|already claimed/);
      }
      expect(fixture.refreshCalls()).toBe(0);
      expect(fixture.readCredential()).toEqual(fixture.original);
      expect(fixture.readPeerStore()?.profiles[profileId]).toEqual(fixture.original);
      expect(fixture.readEmptyStore()).toBeNull();
      expect(fixture.readConflictingCredential()).toEqual(fixture.conflictingFence);
    },
  );
});
