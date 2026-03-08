import type { ClawdbotConfig } from "openclaw/plugin-sdk/lanxin";

export function isLanxinDebugEnabled(cfg?: ClawdbotConfig): boolean {
  const env = (process.env.OPENCLAW_LANXIN_DEBUG ?? "").trim();
  if (env === "1" || env.toLowerCase() === "true") {
    return true;
  }
  const cfgFlag = (cfg?.channels?.lanxin as Record<string, unknown> | undefined)?.debug;
  return cfgFlag === true;
}

export function logLanxinDebug(
  cfg: ClawdbotConfig | undefined,
  message: string,
  meta?: unknown,
): void {
  if (!isLanxinDebugEnabled(cfg)) {
    return;
  }
  if (meta === undefined) {
    console.log(`[lanxin][debug] ${message}`);
    return;
  }
  console.log(`[lanxin][debug] ${message}`, meta);
}
