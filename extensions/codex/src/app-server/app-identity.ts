/**
 * Apps SDK manifests and installed Codex connections can name the same app
 * with asdk_app_ and legacy connector_ prefixes. Only the shared 128-bit ID
 * establishes equivalence; display names never establish app ownership.
 * Keep the installed ID for native config and calls. This comparison bridge
 * can retire when installed inventories consistently return Apps SDK IDs.
 */
export function codexAppIdentityKey(id: string): string {
  return id.replace(/^connector_([a-f0-9]{32})$/, "asdk_app_$1");
}

/** Resolves a declared app against account-authorized runtime metadata. */
export function findCodexAppById<App extends { id: string }>(
  apps: readonly App[],
  id: string,
): App | undefined {
  return (
    apps.find((app) => app.id === id) ??
    apps.find((app) => codexAppIdentityKey(app.id) === codexAppIdentityKey(id))
  );
}
