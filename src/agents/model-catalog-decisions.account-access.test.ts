import { expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createModelCatalogDecisions } from "./model-catalog-decisions.js";
import { createPreparedAccountCatalogAccess } from "./prepared-model-runtime.catalog-auth.js";

it("keeps authenticated shared access through cold account selection but honors an empty publication", async () => {
  const profileId = "openai:fixture";
  const credential = { type: "token" as const, provider: "openai", token: "synthetic-token" };
  const outcome = {
    provider: "openai",
    profileId,
    status: "ready" as const,
    modelAccessPrograms: [
      { modelId: "fixture", runtimeId: "openclaw", cyber: ["daybreak_blue"] as const },
    ],
  };
  const accountCatalog = createPreparedAccountCatalogAccess(() => true);
  const prepare = () =>
    createModelCatalogDecisions({
      cfg: {},
      agentId: "main",
      preferredProfileId: profileId,
      profileProvider: "openai",
      snapshot: { entries: [], routeVariants: [], providerOutcomes: [outcome] },
      metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
      preparedAuthStore: { version: 1, profiles: { [profileId]: credential } },
      accountCatalog,
      isCurrent: () => true,
    });
  const cold = prepare();
  await cold.prepareSelectedAccountCatalog(() => {}, {});
  expect(cold.snapshot.providerOutcomes).toEqual([outcome]);
  await accountCatalog.acquire({
    profileId,
    credential,
    allowDiscovery: true,
    load: async () => [],
  });
  const empty = prepare();
  await empty.prepareSelectedAccountCatalog(() => {}, {});
  expect(empty.snapshot.providerOutcomes).toEqual([]);
});
