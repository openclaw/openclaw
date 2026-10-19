/** HTTP surface: `GET /plugins/geolocation/lookup?ip=<address>`. */
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import { sendLengthFramedJson as sendJson } from "openclaw/plugin-sdk/http-response-runtime";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import type { createGeolocationLookup } from "./lookup.js";

export function createGeolocationLookupHandler(lookup: ReturnType<typeof createGeolocationLookup>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.endsWith("/lookup")) {
      return false;
    }
    const ip = url.searchParams.get("ip")?.trim() ?? "";
    if (!net.isIP(ip)) {
      sendJson(res, 400, { error: "ip must be a valid IPv4 or IPv6 address" });
      return true;
    }
    const scope = getPluginRuntimeGatewayRequestScope();
    const result = await lookup(ip, async () => {
      await scope?.revalidate?.();
    });
    if (result.status === "unavailable") {
      sendJson(res, 503, { error: "geolocation database unavailable" });
    } else {
      const { ip: _ip, status, ...location } = result;
      sendJson(res, 200, {
        found: status === "found",
        ...location,
      });
    }
    return true;
  };
}
