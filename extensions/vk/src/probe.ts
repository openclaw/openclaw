import { getVkGroupsById } from "./api.js";
import type { ResolvedVkAccount, VkProbeResult } from "./types.js";

export async function probeVkAccount(params: {
  account: ResolvedVkAccount;
  timeoutMs?: number;
}): Promise<VkProbeResult> {
  const controller = new AbortController();
  const timeoutMs = params.timeoutMs ?? 2500;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const groups = await Promise.race([
      getVkGroupsById(params.account.token),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error(`VK probe timed out after ${String(timeoutMs)}ms`)),
          { once: true },
        );
      }),
    ]);
    const group = groups[0];
    if (!group) {
      return {
        ok: false,
        error: "VK token did not resolve a group",
      };
    }
    return {
      ok: true,
      group: {
        id: group.id,
        name: group.name,
        screenName: group.screen_name,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
