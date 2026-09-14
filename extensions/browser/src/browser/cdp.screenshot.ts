import type { lookup as dnsLookupCb } from "node:dns";
import { withCdpSocket } from "./cdp.helpers.js";

/** Capture a PNG or JPEG screenshot through CDP, optionally full-page. */
export async function captureScreenshot(opts: {
  wsUrl: string;
  lookup?: typeof dnsLookupCb;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number; // jpeg only (0..100)
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Effective launch mode recorded on the owned Chrome process, when known. */
  headless?: boolean;
}): Promise<Buffer> {
  return await withCdpSocket(
    opts.wsUrl,
    async (send) => {
      await send("Page.enable");

      // Headless background tabs need activation to produce a frame. Preserve
      // focus only when the browser process is authoritatively known headed.
      if (opts.headless !== false) {
        await send("Page.bringToFront").catch(() => {});
      }

      const format = opts.format ?? "png";
      const quality =
        format === "jpeg" ? Math.max(0, Math.min(100, Math.round(opts.quality ?? 85))) : undefined;

      // This path has no Playwright viewport owner. Chromium captures the whole
      // document without changing its layout; emulated pages use their owner session.
      const result = await send("Page.captureScreenshot", {
        format,
        ...(quality !== undefined ? { quality } : {}),
        ...(opts.fullPage ? { captureBeyondViewport: true } : {}),
      });

      const base64 =
        typeof result === "object" && result !== null && "data" in result ? result.data : undefined;
      if (typeof base64 !== "string" || !base64) {
        throw new Error("Screenshot failed: missing data");
      }
      return Buffer.from(base64, "base64");
    },
    {
      commandTimeoutMs: opts.timeoutMs,
      lookup: opts.lookup,
      signal: opts.signal,
      abortScope: "operation",
    },
  );
}
