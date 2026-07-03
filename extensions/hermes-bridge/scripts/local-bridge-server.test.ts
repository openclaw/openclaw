import { describe, expect, it } from "vitest";
import {
  buildStartupDiagnostics,
  createLocalHealthPayload,
  HERMES_BRIDGE_LOCAL_ALLOWED_TASKS,
} from "./local-bridge-server.js";

describe("Hermes bridge local server startup diagnostics", () => {
  it("reports host, port, route, token state, and allowed dry-run tasks", () => {
    expect(
      buildStartupDiagnostics({
        host: "127.0.0.1",
        port: 18789,
        env: {
          OPENCLAW_GATEWAY_TOKEN: "gateway-token",
          OPENCLAW_HERMES_BRIDGE_TOKEN: "bridge-token",
        },
      }),
    ).toEqual({
      host: "127.0.0.1",
      port: 18789,
      healthUrl: "http://127.0.0.1:18789/healthz",
      taskRoute: "/api/plugins/hermes-bridge/tasks",
      gatewayTokenConfigured: true,
      bridgeTokenConfigured: true,
      dryRunDefault: true,
      allowedTasks: HERMES_BRIDGE_LOCAL_ALLOWED_TASKS,
    });
  });

  it("keeps healthz independent from external channel tokens", () => {
    expect(createLocalHealthPayload({ host: "127.0.0.1", port: 18789 })).toEqual({
      ok: true,
      status: "live",
      bridge: "hermes-bridge-local",
      host: "127.0.0.1",
      port: 18789,
      dryRunDefault: true,
    });
  });
});
