import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { mcpRelayConfigSchema, parseMcpRelayConfig } from "./src/config.js";
import { identityFromPrivateKey, RelayError, safeError } from "./src/protocol.js";
import type { RelayService } from "./src/service.js";

export default definePluginEntry({
  id: "mcp-relay",
  name: "MCP Relay",
  description: "Connect remote MCP clients to this Gateway through an outbound relay",
  configSchema: mcpRelayConfigSchema,
  register(api) {
    let service: RelayService | undefined;
    api.registerCli(
      async (context) => {
        const { registerMcpRelayCli } = await import("./src/cli.js");
        await registerMcpRelayCli(context);
      },
      {
        descriptors: [
          {
            name: "mcp-relay",
            description: "Inspect the MCP relay connection and manage client grants",
            hasSubcommands: true,
          },
        ],
      },
    );
    for (const operation of ["status", "pair", "grants", "revoke"] as const) {
      api.registerGatewayMethod(
        `mcp-relay.${operation}`,
        async ({ params, respond, signal, hasCurrentClientAuthority }) => {
          const assertCurrent = () => {
            signal?.throwIfAborted();
            if (hasCurrentClientAuthority && !hasCurrentClientAuthority()) {
              throw new RelayError(
                "unavailable",
                "Gateway authorization ended. Reconnect and retry the command.",
              );
            }
          };
          try {
            assertCurrent();
            const active = service;
            if (!active) {
              throw new RelayError(
                "unavailable",
                "MCP relay is not running. Enable mcp-relay and restart the Gateway.",
              );
            }
            if (
              !isRecord(params) ||
              Object.keys(params).some((key) => operation !== "revoke" || key !== "grantId")
            ) {
              throw new RelayError(
                "invalid_params",
                "Use openclaw mcp-relay status, pair, grants, or revoke <grantId>.",
              );
            }
            let result: unknown;
            if (operation === "revoke") {
              if (
                typeof params.grantId !== "string" ||
                !params.grantId.trim() ||
                params.grantId.length > 200
              ) {
                throw new RelayError(
                  "invalid_params",
                  "Supply a grant ID from openclaw mcp-relay grants.",
                );
              }
              result = await active.revoke(params.grantId, assertCurrent);
            } else if (operation === "pair") {
              result = await active.pair(assertCurrent);
            } else {
              result = await active[operation]();
            }
            assertCurrent();
            respond(true, result);
          } catch (error) {
            const safe = safeError(error);
            respond(false, undefined, {
              code: safe.code === "invalid_params" ? "INVALID_REQUEST" : "UNAVAILABLE",
              message: safe.message,
              details: { code: safe.code },
            });
          }
        },
        { scope: operation === "status" ? "operator.read" : "operator.admin" },
      );
    }
    api.registerService({
      id: "mcp-relay",
      apiVersion: 2,
      async start(context) {
        const { RelayState } = await import("./src/state.js");
        const { RelayService: Service } = await import("./src/service.js");
        const { createOperations } = await import("./src/operations.js");
        const config = parseMcpRelayConfig(api.pluginConfig);
        const scheduler = context.scheduler;
        const state = new RelayState(
          api.runtime,
          config.relayUrl,
          () => scheduler.signal.throwIfAborted(),
          scheduler.now,
        );
        const identity = identityFromPrivateKey((await state.initialize()).privateKey);
        scheduler.signal.throwIfAborted();
        const gateway = { name: "OpenClaw", version: api.runtime.version };
        service = new Service({
          scheduler,
          state,
          identity,
          relayUrl: config.relayUrl,
          gateway,
          operations: createOperations({
            runtime: api.runtime,
            logger: api.logger,
            gateway,
            agentId: config.agentId,
            now: scheduler.now,
          }),
        });
        service.start();
      },
      async stop() {
        const active = service;
        service = undefined;
        await active?.stop();
      },
    });
  },
});
