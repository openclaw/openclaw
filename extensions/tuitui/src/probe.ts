import { probeTuitui } from "./api.js";

export type TuituiProbeResult = {
  ok: boolean;
  error?: string;
  elapsedMs: number;
};

export async function probeTuituiAccount(
  appId: string,
  secret: string,
  timeoutMs = 5000,
): Promise<TuituiProbeResult> {
  return probeTuitui(appId, secret, timeoutMs);
}
