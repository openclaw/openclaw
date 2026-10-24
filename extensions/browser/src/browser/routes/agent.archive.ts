import path from "node:path";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  resolveProfileContext,
  withPlaywrightRouteContext,
} from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toStringOrEmpty } from "./utils.js";

export function registerBrowserAgentArchiveRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/archive", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
      return jsonError(res, 501, "Page archives require a Chromium CDP profile.");
    }
    await withPlaywrightRouteContext({
      req,
      res,
      ctx,
      profileCtx,
      targetId: toStringOrEmpty(readBody(req).targetId) || undefined,
      feature: "archive",
      enforceCurrentUrlAllowed: true,
      run: async ({ cdpUrl, tab, pw, signal, assertCurrent }) => {
        const { buffer } = await pw.archiveViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          signal,
          assertCurrent,
          ...browserNavigationPolicyForProfile(ctx, profileCtx),
        });
        await assertCurrent?.();
        // Native capture can outlive a caller; fence every media publication await.
        const assertCommitAllowed = () => {
          signal.throwIfAborted();
          if (req.requester?.isCurrent() === false) {
            throw new Error("Browser requester is no longer active");
          }
        };
        const saved = await saveMediaBuffer(
          buffer,
          "multipart/related",
          "browser",
          undefined,
          "page.mhtml",
          undefined,
          { assertCommitAllowed },
        );
        res.json({
          ok: true,
          path: path.resolve(saved.path),
          targetId: tab.targetId,
          url: tab.url,
        });
      },
    });
  });
}
