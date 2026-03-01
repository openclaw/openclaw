/**
 * Feishu probe - delegates to core runtime.channel.feishu.
 */
import type { FeishuClientCredentials } from "./client.js";
import { getFeishuRuntime } from "./runtime.js";
import type { FeishuProbeResult } from "./types.js";

export async function probeFeishu(creds?: FeishuClientCredentials): Promise<FeishuProbeResult> {
  return getFeishuRuntime().channel.feishu.probeFeishu(creds);
}

export function clearProbeCache(): void {
  getFeishuRuntime().channel.feishu.clearProbeCache();
}
