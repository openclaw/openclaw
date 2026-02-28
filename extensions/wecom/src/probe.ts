import type { ResolvedWeComAccount } from "./types.js";

export async function probeWeCom(account: ResolvedWeComAccount): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!account.configured) {
    return { ok: false, error: "Not configured" };
  }

  // TODO: Implement actual probe (e.g., test API call)
  return { ok: true };
}
