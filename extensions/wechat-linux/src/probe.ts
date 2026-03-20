import { probeWechatLinuxBridge } from "./bridge.js";
import type { BridgeProbe, CoreConfig, ResolvedWechatLinuxAccount } from "./types.js";

export async function probeWechatLinux(
  _cfg: CoreConfig,
  params: { account: ResolvedWechatLinuxAccount; timeoutMs: number },
): Promise<BridgeProbe> {
  return await probeWechatLinuxBridge(params.account, params.timeoutMs);
}
