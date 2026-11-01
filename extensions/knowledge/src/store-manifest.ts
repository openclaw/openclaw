import { Type, type Static } from "typebox";

const uuid = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
});
/** Store identity file (`vault.json`). The store, not an agent, owns the vault:
 * `vaultId` is the immutable physical identity; generation/publicationId fence
 * publication, replacement and restore. */
export const Manifest = Type.Object(
  {
    format: Type.Literal("knowledge-vault-v2"),
    vaultId: uuid,
    generation: Type.Integer({ minimum: 0 }),
    publicationId: uuid,
  },
  { additionalProperties: false },
);
export type Manifest = Static<typeof Manifest>;
/** SQLite checkpoint key for a store's manifest. */
export const checkpointKey = (vaultId: string) => `store:${vaultId}`;
