/**
 * Browser agent action routes for download handling.
 *
 * Registers endpoints that wait for a pending download or trigger a referenced
 * page download while keeping files scoped to the configured downloads root.
 */
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ensureOutputDirectory } from "../output-directories.js";
import { DEFAULT_DOWNLOAD_DIR } from "../paths.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  requirePwAi,
  withRouteTabContext,
} from "./agent.shared.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { resolveWritableOutputPathOrRespond } from "./output-paths.js";
import { readRouteTimerTimeoutMs } from "./route-numeric.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toStringOrEmpty } from "./utils.js";

/** Register download action endpoints on the browser control server. */
export function registerBrowserAgentActDownloadRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  for (const mode of ["wait", "download"] as const) {
    app.post(mode === "wait" ? "/wait/download" : "/download", async (req, res) => {
      const body = readBody(req);
      const targetId = normalizeOptionalString(body.targetId);
      const out = toStringOrEmpty(body.path);
      const ref = toStringOrEmpty(body.ref);
      const currentDocument = mode === "download" && body.currentDocument === true;
      const expectedUrl = typeof body.expectedUrl === "string" ? body.expectedUrl : "";
      let timeoutMs: number | undefined;
      try {
        timeoutMs = readRouteTimerTimeoutMs(body.timeoutMs);
      } catch (err) {
        return jsonError(res, 400, formatErrorMessage(err));
      }
      if (mode === "download") {
        if (body.currentDocument !== undefined && typeof body.currentDocument !== "boolean") {
          return jsonError(res, 400, "currentDocument must be a boolean");
        }
        if (currentDocument && (body.ref !== undefined || body.path !== undefined)) {
          return jsonError(res, 400, "currentDocument cannot be combined with ref or path");
        }
        if (currentDocument && !expectedUrl.trim()) {
          return jsonError(res, 400, "expectedUrl is required for currentDocument");
        }
        if (!currentDocument && body.expectedUrl !== undefined) {
          return jsonError(res, 400, "expectedUrl requires currentDocument");
        }
        if (!currentDocument && !ref) {
          return jsonError(res, 400, "ref is required");
        }
        if (!currentDocument && !out) {
          return jsonError(res, 400, "path is required");
        }
      }

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        enforceCurrentUrlAllowed: true,
        run: async ({ profileCtx, cdpUrl, tab, signal, assertCurrent }) => {
          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            return jsonError(
              res,
              501,
              mode === "wait"
                ? EXISTING_SESSION_LIMITS.download.waitUnsupported
                : EXISTING_SESSION_LIMITS.download.downloadUnsupported,
            );
          }
          const pw = await requirePwAi(res, mode === "wait" ? "wait for download" : "download");
          if (!pw) {
            return;
          }
          await ensureOutputDirectory(DEFAULT_DOWNLOAD_DIR);
          let downloadPath: string | undefined;
          if (!currentDocument && out) {
            const resolved = await resolveWritableOutputPathOrRespond({
              res,
              rootDir: DEFAULT_DOWNLOAD_DIR,
              requestedPath: out,
              scopeLabel: "downloads directory",
            });
            if (!resolved) {
              return;
            }
            downloadPath = resolved;
          }
          const target = {
            cdpUrl,
            targetId: tab.targetId,
            timeoutMs,
            ...browserNavigationPolicyForProfile(ctx, profileCtx),
            rootDir: DEFAULT_DOWNLOAD_DIR,
            signal,
            ...(assertCurrent ? { assertCurrent } : {}),
          };
          const result = currentDocument
            ? await pw.downloadCurrentDocumentViaPlaywright({ ...target, expectedUrl })
            : mode === "wait"
              ? await pw.waitForDownloadViaPlaywright({ ...target, path: downloadPath })
              : await pw.downloadViaPlaywright({ ...target, ref, path: downloadPath! });
          res.json({ ok: true, targetId: tab.targetId, download: result });
        },
      });
    });
  }
}
