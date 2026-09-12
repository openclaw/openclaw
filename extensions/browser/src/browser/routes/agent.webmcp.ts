import { getChromeMcpModule } from "../chrome-mcp.runtime.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import { assertExistingSessionPostInteractionNavigationAllowed } from "./agent.act.existing-session.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  resolveProfileContext,
  resolveTargetIdFromBody,
  withRouteTabContext,
} from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError } from "./utils.js";

export function registerBrowserWebMcpRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  for (const action of ["list", "execute"] as const) {
    app.post(`/webmcp/${action}`, async (req, res) => {
      const body = readBody(req);
      const profileCtx = resolveProfileContext(req, res, ctx);
      if (!profileCtx) {
        return;
      }
      if (!getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
        return jsonError(res, 501, "WebMCP requires an existing-session Chrome MCP profile.");
      }
      if (
        action === "execute" &&
        (typeof body.contextId !== "string" ||
          !body.contextId ||
          typeof body.toolName !== "string" ||
          !body.toolName.trim())
      ) {
        return jsonError(
          res,
          400,
          "webmcp_execute requires contextId from webmcp_list and toolName.",
        );
      }
      if (
        body.input !== undefined &&
        (!body.input || typeof body.input !== "object" || Array.isArray(body.input))
      ) {
        return jsonError(res, 400, "WebMCP input must be a JSON object.");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        profileCtx,
        targetId: resolveTargetIdFromBody(body),
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, signal }) => {
          const params = {
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            signal,
            timeoutMs: ctx.state().resolved.actionTimeoutMs,
          };
          const initialTabs = action === "execute" ? await profileCtx.listTabs({ signal }) : [];
          const mcp = await getChromeMcpModule();
          const outcome = await mcp
            .runChromeMcpWebMcp(
              {
                ...params,
                contextId: typeof body.contextId === "string" ? body.contextId : undefined,
                toolName: typeof body.toolName === "string" ? body.toolName : undefined,
                // SAFETY: The request guard above accepts only non-null, non-array objects.
                input: body.input as Record<string, unknown> | undefined,
              },
              action === "execute",
            )
            .then(
              (result) => ({ result }),
              (error: unknown) => ({ error }),
            );
          if (action === "execute") {
            try {
              await assertExistingSessionPostInteractionNavigationAllowed({
                ...params,
                ...browserNavigationPolicyForProfile(ctx, profileCtx),
                listTabs: () => profileCtx.listTabs({ signal }),
                initialTabTargetIds: new Set(initialTabs.map((entry) => entry.targetId)),
              });
            } catch (cause) {
              throw new AggregateError(
                "error" in outcome ? [outcome.error, cause] : [cause],
                "WebMCP execution outcome unknown. Inspect the page before retrying. Post-interaction navigation blocked or could not be verified.",
                { cause },
              );
            }
          }
          if ("error" in outcome) {
            throw outcome.error;
          }
          res.json({ ok: true, targetId: tab.targetId, ...outcome.result });
        },
      });
    });
  }
}
