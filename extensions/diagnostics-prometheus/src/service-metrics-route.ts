import type { IncomingMessage, ServerResponse } from "node:http";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenClawPluginHttpRouteHandler } from "../api.js";

// Gateway authentication applies the caller's named-role scope ceiling, but the route's own
// read authorization belongs to this plugin. Mirror the Gateway read implication set so a
// scope-narrowed operator identity cannot scrape diagnostics it may not read.
const METRICS_READ_SCOPE = "operator.read";
const METRICS_READ_IMPLYING_SCOPES = [
  METRICS_READ_SCOPE,
  "operator.write",
  "operator.admin",
] as const;

function hasMetricsReadScope(): boolean {
  const runtimeScopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes;
  const scopes = Array.isArray(runtimeScopes) ? runtimeScopes : [];
  return METRICS_READ_IMPLYING_SCOPES.some((scope) => scopes.includes(scope));
}

export function createMetricsHandler(render: () => Buffer): OpenClawPluginHttpRouteHandler {
  return (req: IncomingMessage, res: ServerResponse) => {
    // Fail closed before any metric rendering, including for HEAD probes that would
    // otherwise disclose the document size to an unauthorized caller.
    if (!hasMetricsReadScope()) {
      res.statusCode = 403;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`missing scope: ${METRICS_READ_SCOPE}`);
      return true;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end("Method Not Allowed");
      return true;
    }

    const body = render();
    res.statusCode = 200;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.setHeader("Content-Length", String(body.length));
    res.flushHeaders();
    res.end(req.method === "HEAD" ? undefined : body, (error?: Error | null) => {
      // Only the completed response owns this backing store; prefixes stay in the metric store.
      // Skip pooled or zero-length buffers; transfer() would detach memory the process still uses.
      const backing = body.buffer;
      if (
        !error &&
        body.byteLength > 0 &&
        body.byteOffset === 0 &&
        backing instanceof ArrayBuffer &&
        backing.byteLength === body.byteLength
      ) {
        backing.transfer(0);
      }
    });
    return true;
  };
}
