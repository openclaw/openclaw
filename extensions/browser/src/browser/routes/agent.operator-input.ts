import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ACT_MAX_BATCH_ACTIONS } from "../act-policy.js";
import { BROWSER_ACT_ERROR_CODES } from "../errors.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserOperatorInput } from "../pw-tools-core.interactions.operator.js";
import type { BrowserRouteContext } from "../server-context.js";
import { normalizeActRequest } from "./agent.act.normalize.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  requirePwAi,
  resolveProfileContext,
  withRouteTabContext,
} from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";

/** Reuse act validation so operator input accepts exactly what act accepts for these kinds. */
function normalizeOperatorInputs(value: unknown): BrowserOperatorInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("inputs must be a non-empty array");
  }
  if (value.length > ACT_MAX_BATCH_ACTIONS) {
    throw new Error(`inputs exceeds maximum of ${ACT_MAX_BATCH_ACTIONS}`);
  }
  return value.map((entry): BrowserOperatorInput => {
    const record = isRecord(entry) ? entry : undefined;
    if (!record || !["press", "insertText", "clickCoords"].includes(String(record.kind))) {
      throw new Error("each input must be press, insertText or clickCoords");
    }
    const action = normalizeActRequest({
      kind: record.kind,
      key: record.key,
      text: record.text,
      x: record.x,
      y: record.y,
    });
    switch (action.kind) {
      case "press":
        return { kind: "press", key: action.key };
      case "insertText":
        return { kind: "insertText", text: action.text };
      case "clickCoords":
        return { kind: "clickCoords", x: action.x, y: action.y };
      default:
        throw new Error("each input must be press, insertText or clickCoords");
    }
  });
}

/**
 * Human input from the Control UI browser panel. Agent tools keep `/act`, which
 * guards each action separately.
 */
export function registerBrowserOperatorInputRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/operator/input", async (req, res) => {
    const body = readBody(req);
    let inputs: BrowserOperatorInput[];
    try {
      inputs = normalizeOperatorInputs(body.inputs);
    } catch (err) {
      res.status(400).json({
        error: formatErrorMessage(err),
        code: BROWSER_ACT_ERROR_CODES.invalidRequest,
      });
      return;
    }
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const capabilities = getBrowserProfileCapabilities(profileCtx.profile);
    // Operator input drives Playwright mouse and keyboard on a rendered page.
    if (capabilities.usesChromeMcp || !capabilities.supportsVisualActions) {
      res.status(501).json({
        error: "Operator input sessions need a Playwright-managed Chromium profile.",
        code: "OPERATOR_INPUT_UNSUPPORTED",
      });
      return;
    }
    await withRouteTabContext({
      req,
      res,
      ctx,
      profileCtx,
      targetId: normalizeOptionalString(body.targetId),
      enforceCurrentUrlAllowed: true,
      run: async ({ cdpUrl, tab, signal, assertCurrent }) => {
        const pw = await requirePwAi(res, "operator input");
        if (!pw) {
          return;
        }
        if (assertCurrent) {
          await assertCurrent();
        }
        const result = await pw.sendOperatorInputViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          inputs,
          ...browserNavigationPolicyForProfile(ctx, profileCtx),
          signal,
          ...(assertCurrent ? { assertCurrent } : {}),
        });
        res.json({ ok: true, ...result });
      },
    });
  });
}
