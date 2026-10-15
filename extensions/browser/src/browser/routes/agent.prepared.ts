import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserRouteContext } from "../server-context.js";
import { readBody, withRouteTabContext, type RouteTabContext } from "./agent.shared.js";
import type { BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { jsonError } from "./utils.js";

type PreparedTabRoute = (context: RouteTabContext) => Promise<void>;

/** Prepare guarded tab actions before profile admission; dispatch remains driver-specific. */
export function createTabRouteRegistrar(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  return (
    path: string,
    prepare: (body: Record<string, unknown>, res: BrowserResponse) => PreparedTabRoute | void,
  ) => {
    app.post(path, async (req, res) => {
      const body = readBody(req);
      const targetId = normalizeOptionalString(body.targetId);
      let run: ReturnType<typeof prepare>;
      try {
        run = prepare(body, res);
      } catch (err) {
        return jsonError(res, 400, formatErrorMessage(err));
      }
      if (!run) {
        return;
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        enforceCurrentUrlAllowed: true,
        run,
      });
    });
  };
}
