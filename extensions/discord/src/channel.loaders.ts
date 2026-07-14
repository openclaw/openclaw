// Discord plugin module implements channel.loaders behavior.
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

export const loadDiscordDirectoryConfigModule = createLazyRuntimeModule(
  () => import("./directory-config.js"),
);
export const loadDiscordResolveChannelsModule = createLazyRuntimeModule(
  () => import("./resolve-channels.js"),
);
export const loadDiscordResolveUsersModule = createLazyRuntimeModule(
  () => import("./resolve-users.js"),
);
export const loadDiscordThreadBindingsManagerModule = createLazyRuntimeModule(
  () => import("./monitor/thread-bindings.manager.js"),
);
export const loadDiscordTargetResolverModule = createLazyRuntimeModule(
  () => import("./target-resolver.js"),
);

export const loadDiscordProviderRuntime = createLazyRuntimeModule(
  () => import("./monitor/provider.runtime.js"),
);

export const loadDiscordProbeRuntime = createLazyRuntimeModule(() => import("./probe.runtime.js"));

export const loadDiscordAuditModule = createLazyRuntimeModule(() => import("./audit.js"));

export const loadDiscordSendModule = createLazyRuntimeModule(() => import("./send.js"));

export const loadDiscordDirectoryLiveModule = createLazyRuntimeModule(
  () => import("./directory-live.js"),
);
