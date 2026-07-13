import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { AuditRow, StandingGrant } from "./src/broker.js";
import { OnePasswordBroker } from "./src/broker.js";
import { MAX_REGISTERED_ITEMS, parseOnePasswordConfig } from "./src/config.js";
import { OpClient } from "./src/op-client.js";
import { createOnePasswordTool, redactPersistedOnePasswordResult } from "./src/tool.js";

const MAX_AUDIT_ROWS = 40_000;

export default definePluginEntry({
  id: "onepassword",
  name: "1Password",
  description: "Curated 1Password secrets broker with approval policy and SQLite audit history.",
  register(api) {
    const config = parseOnePasswordConfig(api.pluginConfig);
    const grants = api.runtime.state.openKeyedStore<StandingGrant>({
      namespace: "grants",
      maxEntries: MAX_REGISTERED_ITEMS,
      overflowPolicy: "reject-new",
    });
    const audit = api.runtime.state.openKeyedStore<AuditRow>({
      namespace: "audit",
      maxEntries: MAX_AUDIT_ROWS,
      overflowPolicy: "evict-oldest",
    });
    const tokenFile = path.join(
      api.runtime.state.resolveStateDir(process.env),
      "credentials",
      "onepassword",
      "service-account-token",
    );
    const opClient = new OpClient({
      opBin: config?.opBin,
      tokenFile,
      timeoutMs: config?.opTimeoutMs ?? 15_000,
      warn: (message) => api.logger.warn(message),
    });
    const broker = config
      ? new OnePasswordBroker({ config, opClient, stores: { audit, grants } })
      : undefined;

    api.registerCli(
      async ({ program }) => {
        const { registerOnePasswordCommands } = await import("./src/cli.js");
        registerOnePasswordCommands({ program, config, opClient, auditStore: audit });
      },
      {
        descriptors: [
          {
            name: "onepassword",
            description: "Inspect the 1Password secrets broker",
            hasSubcommands: true,
          },
        ],
      },
    );

    if (!broker) {
      return;
    }
    api.registerTool((context) => createOnePasswordTool(broker, context), {
      name: "onepassword",
    });
    api.on("before_tool_call", (event, ctx) => broker.beforeToolCall(event, ctx));
    api.on("tool_result_persist", redactPersistedOnePasswordResult);
  },
});
