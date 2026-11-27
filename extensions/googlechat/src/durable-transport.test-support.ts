import type { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";

export async function withDurableGoogleChatTransport(
  label: string,
  run: (send: typeof sendDurableMessageBatch) => Promise<void>,
) {
  await withOpenClawTestState({ label, layout: "state-only" }, async () => {
    const [
      { sendDurableMessageBatch },
      { createTestRegistry, withPluginRuntimeRegistryScope },
      { googlechatPlugin },
    ] = await Promise.all([
      import("openclaw/plugin-sdk/channel-outbound"),
      import("openclaw/plugin-sdk/channel-test-helpers"),
      import("../api.js"),
    ]);
    await withPluginRuntimeRegistryScope(
      createTestRegistry([{ pluginId: "googlechat", plugin: googlechatPlugin, source: "test" }]),
      () => run(sendDurableMessageBatch),
    );
  });
}
