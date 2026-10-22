import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";

export function isOnlyMigrationKind(
  { itemKinds }: MigrationProviderContext,
  kind: "memory" | "auth",
): boolean {
  return Boolean(itemKinds?.length && itemKinds.every((itemKind) => itemKind === kind));
}
