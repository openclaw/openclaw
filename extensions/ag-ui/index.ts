import type { IncomingMessage, ServerResponse } from "node:http";
// AG-UI channel plugin entrypoint.
//
// Registers the bundled AG-UI channel (an HTTP/SSE endpoint that speaks the
// AG-UI protocol) the same way every other bundled channel does: via
// `defineBundledChannelEntry`, so the control-plane can discover the channel
// (id/metadata/plugin surface) without executing runtime code, and the full
// runtime wiring (HTTP routes, tool lifecycle hooks, CLI) happens in
// `registerFull`. The ChannelPlugin itself is resolved lazily from the
// `channel-plugin-api.js` public surface below.
import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { cronReportToolFactory } from "./examples/cron-report-tool.js";

type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
type HttpHandlerFactory = (api: OpenClawPluginApi) => HttpHandler;

// Lazily load runtime pieces from the `./api.js` surface so discovery/config
// passes never pull the HTTP handler, tool, or hook code into memory.
// eslint-disable-next-line typescript/no-unnecessary-type-parameters -- T lets each call site name the artifact type it loads
function loadApi<T>(exportName: string): T {
  return loadBundledEntryExportSync<T>(import.meta.url, {
    specifier: "./api.js",
    exportName,
  });
}

export default defineBundledChannelEntry({
  id: "ag-ui",
  name: "AG-UI",
  description: "AG-UI protocol endpoint for AG-UI clients",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "aguiChannelPlugin",
  },
  registerFull(api: OpenClawPluginApi) {
    // Device-token + pairing route (the plugin performs its own HMAC/pairing
    // auth; auth: "plugin").
    const createAguiHttpHandler = loadApi<HttpHandlerFactory>("createAguiHttpHandler");
    api.registerHttpRoute({
      path: "/v1/ag-ui",
      auth: "plugin",
      match: "exact",
      handler: createAguiHttpHandler(api),
    });

    // Operator-token route for operator-UI-embedded consumers that already hold
    // a gateway token (no second pairing dance). Scoped to `write-default`
    // (operator.write) so a leaked token can invoke agent turns but cannot reach
    // admin/pairing/secrets surfaces.
    const createOperatorAguiHttpHandler = loadApi<HttpHandlerFactory>(
      "createOperatorAguiHttpHandler",
    );
    api.registerHttpRoute({
      path: "/v1/ag-ui/operator",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "write-default",
      handler: createOperatorAguiHttpHandler(api),
    });

    // Frontend/client tools are declared per request via forwardedProps; the
    // factory returns null at discovery (no session) and real tools at runtime.
    api.registerTool(
      loadApi<typeof import("./src/client-tools.js").aguiToolFactory>("aguiToolFactory"),
    );

    // Example server-side tool demonstrating A2UI operations (declared in
    // openclaw.plugin.json contracts.tools). Optional so it never blocks a turn.
    api.registerTool(loadApi<typeof cronReportToolFactory>("cronReportToolFactory"), {
      name: "cron_report",
      optional: true,
    });

    // Map the OpenClaw server-side tool lifecycle onto AG-UI TOOL_CALL_* events.
    api.on(
      "before_tool_call",
      loadApi<typeof import("./src/hooks.js").handleBeforeToolCall>("handleBeforeToolCall"),
    );
    api.on(
      "tool_result_persist",
      loadApi<typeof import("./src/hooks.js").handleToolResultPersist>("handleToolResultPersist"),
    );

    // `openclaw ag-ui` CLI (approved-device listing).
    loadApi<typeof import("./src/cli.js").registerAguiCli>("registerAguiCli")(api);
  },
});
