import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PLUGIN_ID = "heap-rig-catalog";

// The fixture uses the public provider contract and keeps no session cache of its own.
const PLUGIN_SOURCE = `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "heap-rig-catalog",
  name: "Synthetic heap rig catalog",
  description: "Synthetic catalog projection and publication workload",
  register(api) {
    api.registerSessionCatalog({
      id: "heap-rig-catalog",
      label: "Synthetic heap rig catalog",
      audience: "gateway-operators",
      supportsProcessHomeIsolation: true,
      async list(params) {
        if (!params.sessionEntries || !params.agentId) {
          throw new Error("Synthetic catalog requires the Gateway entry snapshot");
        }
        const hostId = "gateway:heap-rig";
        if (params.hostIds && !params.hostIds.includes(hostId)) {
          return [];
        }
        const search = params.search?.toLowerCase();
        const rows = params.sessionEntries.entriesForAgent(params.agentId);
        const sessions = rows
          .filter(({ sessionKey, entry }) => !search ||
            (sessionKey + " " + (entry.label ?? "")).toLowerCase().includes(search))
          .slice(0, params.limitPerHost ?? 100)
          .map(({ sessionKey, entry }) => ({
            threadId: entry.sessionId,
            sessionKey,
            name: entry.label ?? sessionKey,
            status: "idle",
            updatedAt: entry.updatedAt,
            source: "synthetic-heap-rig",
            archived: entry.archivedAt !== undefined,
            canContinue: false,
            canArchive: false,
          }));
        const host = { hostId, label: "Synthetic rig host", kind: "gateway", connected: true, sessions };
        params.onHost?.(host);
        if (params.allowPartialResults && params.waitUntil && params.onHost) {
          // One event-loop turn exercises post-list publication ownership without a timer.
          const publish = params.onHost;
          const signal = params.signal;
          params.waitUntil(new Promise((resolve) => setImmediate(resolve)).then(() => {
            if (!signal?.aborted) {
              publish(host);
            }
          }));
        }
        return [host];
      },
      async read({ hostId, threadId }) {
        return { hostId, threadId, items: [] };
      },
    });
  },
});
`;

/** Exercise Gateway catalog lifetimes; this does not emulate a native provider or its caches. */
export async function configureHeapRigCatalog(config, root) {
  const pluginDir = path.join(root, "plugins", PLUGIN_ID);
  await mkdir(pluginDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(pluginDir, "index.mjs"), PLUGIN_SOURCE),
    writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/heap-rig-catalog",
        private: true,
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.mjs"] },
      }),
    ),
    writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: PLUGIN_ID,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false },
      }),
    ),
  ]);
  const plugins = config.plugins ?? {};
  config.plugins = {
    ...plugins,
    enabled: true,
    ...(plugins.allow ? { allow: [...new Set([...plugins.allow, PLUGIN_ID])] } : {}),
    entries: { ...plugins.entries, [PLUGIN_ID]: { enabled: true } },
    load: { ...plugins.load, paths: [...(plugins.load?.paths ?? []), pluginDir] },
  };
  return { pluginId: PLUGIN_ID, pluginDir };
}
