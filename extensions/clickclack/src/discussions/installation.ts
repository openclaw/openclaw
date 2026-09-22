import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

const INSTALLATION_NAMESPACE = "discussion-installation";
const INSTALLATION_KEY = "current";

/** Returns the durable installation namespace used in server-visible ownership refs. */
export async function getClickClackDiscussionInstallationId(
  runtime: PluginRuntime,
): Promise<string> {
  const store = runtime.state.openKeyedStore<{ id: string }>({
    namespace: INSTALLATION_NAMESPACE,
    maxEntries: 1,
    overflowPolicy: "reject-new",
  });
  const existing = (await store.lookup(INSTALLATION_KEY))?.id;
  if (existing) {
    return existing;
  }
  const id = randomUUID();
  await store.registerIfAbsent(INSTALLATION_KEY, { id });
  const persisted = (await store.lookup(INSTALLATION_KEY))?.id;
  if (!persisted) {
    throw new Error(
      "ClickClack discussion installation identity is unavailable; retry opening the discussion",
    );
  }
  return persisted;
}
