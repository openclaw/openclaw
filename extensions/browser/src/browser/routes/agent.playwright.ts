import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { PwAiModule } from "../pw-ai-module.js";
import type { InteractionTargetOptions } from "../pw-tools-core.interactions.navigation.js";
import type { BrowserRouteContext } from "../server-context.js";
import { readBody, resolveProfileContext, withPlaywrightRouteContext } from "./agent.shared.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { jsonError } from "./utils.js";

type PreparedOperation = (
  pw: PwAiModule,
  target: InteractionTargetOptions,
  signal: AbortSignal,
) => Promise<void | object | null>;

export function createPlaywrightRouteRegistrar(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
  mode: "inspection" | "state",
) {
  return (
    method: "get" | "post",
    path: string,
    feature: string,
    prepare: (
      input: Record<string, unknown>,
      params: BrowserRequest["params"],
      res: BrowserResponse,
    ) => PreparedOperation,
    existingSessionUnsupported?: string,
  ) => {
    app[method](path, async (req, res) => {
      const input = method === "get" ? req.query : readBody(req);
      const targetId = normalizeOptionalString(input.targetId);
      let run: PreparedOperation;
      try {
        run = prepare(input, req.params, res);
      } catch (err) {
        return jsonError(res, 400, formatErrorMessage(err));
      }
      const profileCtx =
        mode === "inspection" || existingSessionUnsupported
          ? resolveProfileContext(req, res, ctx)
          : undefined;
      if (profileCtx === null) {
        return;
      }
      if (
        existingSessionUnsupported &&
        profileCtx &&
        getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp
      ) {
        return jsonError(res, 501, existingSessionUnsupported);
      }
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        profileCtx,
        targetId,
        feature,
        // State mutations are not tab exports; inspection and state reads are guarded.
        ...(mode === "inspection" || method === "get" ? { enforceCurrentUrlAllowed: true } : {}),
        run: async ({ pw, cdpUrl, tab, signal, assertCurrent, resolveTabUrl }) => {
          const result = await run(
            pw,
            {
              ...(mode === "state" && assertCurrent ? { assertCurrent } : {}),
              cdpUrl,
              targetId: tab.targetId,
            },
            signal,
          );
          if (mode === "state") {
            signal.throwIfAborted();
          } else if (result === null) {
            return;
          }
          const url = mode === "inspection" ? await resolveTabUrl(tab.url) : undefined;
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), ...result });
        },
      });
    });
  };
}
