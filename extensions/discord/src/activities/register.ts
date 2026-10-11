import fs from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { createDiscordActivityHttpHandler } from "./http.js";
import { createDiscordWidgetPresenter } from "./presenter.js";
import { DiscordActivitiesRuntime, setDiscordActivitiesRuntime } from "./runtime.js";
import { DISCORD_ACTIVITY_ROUTE_PREFIX } from "./shell.js";
import { DiscordActivityStore, openDiscordActivityStores } from "./store.js";

export function registerDiscordActivities(api: OpenClawPluginApi): void {
  setDiscordActivitiesRuntime(undefined);
  // Registration precedes publication of secret-resolved channel config. Keep the
  // transport static; runtime matching and HTTP dispatch gate on the current snapshot.
  const store = new DiscordActivityStore(
    openDiscordActivityStores(api.runtime.state.openKeyedStore.bind(api.runtime.state)),
  );
  const runtime = new DiscordActivitiesRuntime(
    store,
    api.config,
    api.runtime.config?.current
      ? () => api.runtime.config.current() as typeof api.config
      : undefined,
  );
  setDiscordActivitiesRuntime(runtime);
  const http = createDiscordActivityHttpHandler({
    runtime,
    vendorAssetPath: resolveActivitySdkPath(api),
  });
  api.registerHttpRoute({
    path: DISCORD_ACTIVITY_ROUTE_PREFIX,
    auth: "plugin",
    match: "prefix",
    handler: http.handleHttpRequest,
  });
  api.registerWidgetPresenter(createDiscordWidgetPresenter(runtime));
}

// Source checkouts and bundled dist builds keep the SDK in assets/; the standalone
// npm package copies it to dist/assets/ beside the compiled entry.
function resolveActivitySdkPath(api: OpenClawPluginApi): string {
  const candidates = ["assets/embedded-app-sdk.mjs", "dist/assets/embedded-app-sdk.mjs"].map(
    (input) => api.resolvePath(input),
  );
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}
