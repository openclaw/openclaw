import { z } from "zod";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { getPwAiModule } from "../pw-ai-module.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  withRouteTabContext,
} from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError } from "./utils.js";

const documentId = z.string().min(1).max(128);
const color = z.string().regex(/^#[\da-f]{6}$/i);
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("state") }),
  z.object({ action: z.literal("stop"), documentId }),
  z.object({
    action: z.literal("select"),
    documentId,
    clientX: z.number().finite(),
    clientY: z.number().finite(),
  }),
  z.object({
    action: z.literal("control"),
    documentId,
    change: z.enum(["preview", "preview-original", "reset"]),
    callback: z.string().min(1).max(80),
    value: color,
    virtualTarget: z.object({
      surfaceId: z.string().min(1).max(128),
      targetId: z.string().min(1).max(512),
    }),
  }),
]);
const stateSchema = z.object({
  documentId,
  active: z.boolean(),
  surfaceCount: z.number().int().min(0).max(128),
  selection: z
    .object({
      id: z.string().min(1).max(512),
      name: z.string().max(160),
      role: z.string().max(128).optional(),
      surfaceId: z.string().min(1).max(128),
      rect: z.object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative(),
      }),
      metadata: z
        .unknown()
        .refine((value) => {
          const encoded = JSON.stringify(value);
          return encoded === undefined || encoded.length <= 4096;
        }, "Annotation metadata exceeds the size limit.")
        .optional(),
    })
    .nullable(),
  controls: z
    .array(
      z.object({
        type: z.literal("color"),
        label: z.string().max(128).optional(),
        callback: z.string().min(1).max(80),
        currentValue: color,
      }),
    )
    .max(4),
  controlsHeading: z.string().max(256),
});

export function registerBrowserAnnotationRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/annotations", async (req, res) => {
    if (!ctx.state().resolved.evaluateEnabled) {
      return jsonError(
        res,
        403,
        "Browser annotations are disabled (browser.evaluateEnabled=false).",
      );
    }
    const body = readBody(req);
    const parsed = commandSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(res, 400, "Invalid browser annotation command.");
    }
    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId: typeof body.targetId === "string" ? body.targetId : undefined,
      enforceCurrentUrlAllowed: true,
      run: async ({ profileCtx, tab, cdpUrl, signal, assertCurrent }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          res.status(501).json({
            error: "Page annotations are not available for existing-session profiles.",
            code: "ANNOTATION_UNSUPPORTED",
          });
          return;
        }
        const pw = await getPwAiModule({ mode: "soft" });
        signal.throwIfAborted();
        const afterLoad = assertCurrent?.();
        if (afterLoad) {
          await afterLoad;
        }
        if (!pw) {
          res.status(501).json({
            error: "Page annotations require Playwright in this Gateway build.",
            code: "ANNOTATION_UNSUPPORTED",
          });
          return;
        }
        const result = await pw.annotationsViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          command: parsed.data,
          signal,
          assertCurrent,
          ...browserNavigationPolicyForProfile(ctx, profileCtx),
        });
        signal.throwIfAborted();
        const beforePublish = assertCurrent?.();
        if (beforePublish) {
          await beforePublish;
        }
        // The page main world is untrusted even when our bootstrap supplied the
        // projection. Bound its serialized payload before returning it to clients.
        if (JSON.stringify(result).length > 8_000) {
          throw new Error("Browser annotation state exceeds the size limit.");
        }
        res.json(stateSchema.parse(result));
      },
    });
  });
}
