import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

describe("Nextcloud Talk secret contract", () => {
  it.each([
    { label: "a root baseUrl", baseUrl: "https://cloud.example.invalid", owners: ["default"] },
    // Without a root baseUrl, account listing starts no implicit default account.
    { label: "no root baseUrl", baseUrl: undefined, owners: [] },
  ])(
    "gives the root botSecret to the implicit default account only with $label",
    ({ baseUrl, owners }) => {
      const sourceConfig = {
        channels: {
          "nextcloud-talk": {
            baseUrl,
            botSecret: { source: "env", provider: "default", id: "NC_ROOT_SECRET" },
            accounts: {
              work: { baseUrl: "https://work.example.invalid", botSecret: "work-secret" },
            },
          },
        },
      } satisfies OpenClawConfig;
      const context = createResolverContext({ sourceConfig, env: {} });

      collectRuntimeConfigAssignments({ config: structuredClone(sourceConfig), context });

      expect(context.assignments.map(({ path, ownerId }) => ({ path, ownerId }))).toEqual(
        owners.map((owner) => ({
          path: "channels.nextcloud-talk.botSecret",
          ownerId: `nextcloud-talk:${owner}`,
        })),
      );
    },
  );
});
