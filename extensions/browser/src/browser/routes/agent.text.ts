import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { ChromeMcpDocumentUnavailableError, withChromeMcpDocument } from "../chrome-mcp.js";
import {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS,
} from "../constants.js";
import { assertBrowserNavigationResultAllowed } from "../navigation-guard.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import { createExistingSessionDeadline } from "./agent.act.existing-session.js";
import {
  browserNavigationPolicyForProfile,
  requirePwAi,
  withRouteTabContext,
} from "./agent.shared.js";
import { readRoutePositiveInteger } from "./route-numeric.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError } from "./utils.js";

/** Read bounded page prose through the selected browser's document owner. */
export function registerBrowserAgentTextRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.get("/text", async (req, res) => {
    const targetId = normalizeOptionalString(req.query.targetId);
    const selector = normalizeOptionalString(req.query.selector);
    let maxChars: number;
    try {
      maxChars = Math.min(
        readRoutePositiveInteger(req.query.maxChars, "maxChars") ?? DEFAULT_AI_SNAPSHOT_MAX_CHARS,
        DEFAULT_AI_SNAPSHOT_MAX_CHARS,
      );
    } catch (error) {
      return jsonError(res, 400, formatErrorMessage(error));
    }
    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      enforceCurrentUrlAllowed: true,
      run: async ({ profileCtx, tab, cdpUrl, signal, resolveTabUrl }) => {
        if (!getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          const pw = await requirePwAi(res, "page text");
          if (!pw) {
            return;
          }
          const result = await pw.getPageTextViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            selector,
            maxChars,
            signal,
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), ...result });
          return;
        }

        const deadline = createExistingSessionDeadline(
          DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS,
          signal,
          "Page text extraction",
        );
        try {
          let result: { url: string; text: string; truncated: boolean } | undefined;
          while (!result) {
            deadline.throwIfAborted();
            result = await withChromeMcpDocument(
              {
                profileName: profileCtx.profile.name,
                profile: profileCtx.profile,
                targetId: tab.targetId,
                timeoutMs: DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS,
                signal: deadline.signal,
              },
              async (document) => {
                deadline.throwIfAborted();
                const url = await document.evaluate(`(root) => {
                  const boundDocument = root?.nodeType === 9 ? root : root?.ownerDocument;
                  return boundDocument === document ? location.href : null;
                }`);
                if (typeof url !== "string" || !url) {
                  throw new ChromeMcpDocumentUnavailableError(
                    "Page text document changed; take a new snapshot.",
                  );
                }
                await assertBrowserNavigationResultAllowed({
                  url,
                  signal: deadline.signal,
                  ...browserNavigationPolicyForProfile(ctx, profileCtx),
                });
                deadline.throwIfAborted();
                // No caller-provided code: selector and URL are serialized data.
                // Check again after asynchronous policy admission, before reading prose.
                const value = await document.evaluate(`(root) => {
                  const boundDocument = root?.nodeType === 9 ? root : root?.ownerDocument;
                  if (boundDocument !== document || location.href !== ${JSON.stringify(url)}) {
                    return { kind: "navigation" };
                  }
                  const selector = ${JSON.stringify(selector ?? null)};
                  const node = selector ? document.querySelector(selector)
                    : document.querySelector("article") ?? document.querySelector("main") ?? document.body;
                  if (!node) return { kind: "missing" };
                  const text = node.innerText;
                  if (typeof text !== "string") throw new Error("Page text requires an HTML element");
                  return { kind: "text", text: text.slice(0, ${maxChars + 1}), truncated: text.length > ${maxChars} };
                }`);
                deadline.throwIfAborted();
                if (value && typeof value === "object" && "kind" in value) {
                  if (value.kind === "navigation") {
                    throw new ChromeMcpDocumentUnavailableError(
                      "Page text document changed; take a new snapshot.",
                    );
                  }
                  if (value.kind === "missing") {
                    return undefined;
                  }
                  if (
                    value.kind === "text" &&
                    "text" in value &&
                    typeof value.text === "string" &&
                    "truncated" in value &&
                    typeof value.truncated === "boolean"
                  ) {
                    return {
                      url,
                      text: truncateUtf16Safe(value.text, maxChars),
                      truncated: value.truncated,
                    };
                  }
                }
                throw new Error("Page text extraction returned an invalid result");
              },
            );
            if (!result) {
              await sleep(Math.min(100, deadline.remainingMs()), undefined, {
                signal: deadline.signal,
              });
            }
          }
          deadline.throwIfAborted();
          res.json({ ok: true, targetId: tab.targetId, ...result });
        } finally {
          deadline.cleanup();
        }
      },
    });
  });
}
