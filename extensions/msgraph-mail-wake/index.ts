// Microsoft Graph Mail Wake plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import {
  MAX_DURABLE_GRAPH_MAILBOXES,
  resolveGraphWakePluginConfig,
  type GraphWakePluginConfig,
} from "./src/config.js";
import { createGraphTokenProvider } from "./src/graph-auth.js";
import { createGraphClient } from "./src/graph-client.js";
import { createGraphWakeRequestHandler } from "./src/handler.js";
import { describeErrorRedacted } from "./src/redact.js";
import {
  createGraphSubscriptionManager,
  type GraphSubscriptionManager,
  type GraphWakeSubscriptionRecord,
  type GraphWakeSubscriptionStore,
} from "./src/subscriptions.js";
import { createGraphWakePoster } from "./src/wake.js";

const SUBSCRIPTION_STORE_NAMESPACE = "msgraph-mail-wake.subscriptions";
const AUTH_CONFIG_PATH = "plugins.entries.msgraph-mail-wake.config.auth";

// Re-registration (config reload, gateway restart in the same process) must
// stop the previous manager's timers before a new one starts.
let activeManager: GraphSubscriptionManager | null = null;
// The gateway may call register() more than once per startup (e.g. http-server
// init + agent-runtime pre-warm). Serialize each registration's stop-previous →
// start-new so two starts can never read an empty store concurrently and each
// create a duplicate Graph subscription.
let startChain: Promise<void> = Promise.resolve();

function openSubscriptionStore(api: OpenClawPluginApi): GraphWakeSubscriptionStore {
  // Graph subscription ids and clientState values are required after restart
  // to renew the provider-side subscription and authenticate its deliveries.
  // Fail startup if the canonical SQLite plugin-state store is unavailable;
  // an empty in-memory fallback would orphan the active Graph subscription.
  return api.runtime.state.openSyncKeyedStore<GraphWakeSubscriptionRecord>({
    namespace: SUBSCRIPTION_STORE_NAMESPACE,
    maxEntries: MAX_DURABLE_GRAPH_MAILBOXES,
    overflowPolicy: "reject-new",
  });
}

function registerGraphWake(api: OpenClawPluginApi, config: GraphWakePluginConfig): void {
  const tokenProvider = createGraphTokenProvider({
    auth: config.auth,
    config: api.config,
    authConfigPath: AUTH_CONFIG_PATH,
  });
  const client = createGraphClient({ tokenProvider });
  const store = openSubscriptionStore(api);
  const poster = createGraphWakePoster({ api, client, logger: api.logger });
  const manager = createGraphSubscriptionManager({
    client,
    store,
    mailboxes: config.mailboxes,
    notificationUrl: config.notificationUrl,
    subscription: config.subscription,
    onResync: async ({ record, reason }) => {
      const result = await poster.postResyncWake({ record, reason });
      return result.accepted;
    },
    logger: api.logger,
  });
  const handler = createGraphWakeRequestHandler({
    cfg: api.config,
    path: config.path,
    lookupSubscription: (subscriptionId) => manager.lookup(subscriptionId),
    poster,
    onLifecycleEvent: (event) => manager.handleLifecycleEvent(event),
    logger: api.logger,
  });

  api.registerHttpRoute({
    path: config.path,
    auth: "plugin",
    match: "exact",
    replaceExisting: true,
    handler,
  });

  const previousManager = activeManager;
  activeManager = manager;
  startChain = startChain
    .then(async () => {
      if (previousManager) {
        await previousManager.stop({ deleteRemote: false });
      }
      // A later registration may have superseded this one while we awaited the
      // previous stop; if so, retire this manager without starting it so we
      // never start a manager that is no longer the active one.
      if (activeManager !== manager) {
        await manager.stop({ deleteRemote: false });
        return;
      }
      await manager.start();
    })
    .catch((err: unknown) => {
      api.logger.error?.(
        `[msgraph-mail-wake] subscription_manager_start_failed; error=${describeErrorRedacted(err)}`,
      );
    });

  api.lifecycle.registerRuntimeLifecycle({
    id: "msgraph-mail-wake",
    description: "Microsoft Graph mail subscription manager",
    cleanup: async ({ reason }) => {
      if (activeManager === manager) {
        activeManager = null;
      }
      // disable/delete means the plugin is going away: remove the remote Graph
      // subscriptions too. restart/reset keep them alive — the next start
      // reconciles and renews from the persisted registry instead of churning.
      const deleteRemote = reason === "disable" || reason === "delete";
      await manager.stop({ deleteRemote });
    },
  });

  api.logger.info?.(
    `[msgraph-mail-wake] registered Graph notification route ${config.path} for ${config.mailboxes.length} mailbox(es)`,
  );
}

export default definePluginEntry({
  id: "msgraph-mail-wake",
  name: "Microsoft Graph Mail Wake",
  description: "Microsoft Graph mailbox change notifications that wake OpenClaw agent sessions.",
  register(api: OpenClawPluginApi) {
    // Discovery/setup/CLI registration modes must stay inert: resolving
    // secrets, calling Graph, or creating subscriptions is runtime work and
    // belongs to full gateway registrations only.
    if (api.registrationMode !== "full") {
      api.logger.debug?.(
        `[msgraph-mail-wake] skipping runtime init in "${api.registrationMode}" registration mode`,
      );
      return;
    }
    const config = resolveGraphWakePluginConfig({ pluginConfig: api.pluginConfig });
    if (!config) {
      return;
    }
    registerGraphWake(api, config);
  },
});
