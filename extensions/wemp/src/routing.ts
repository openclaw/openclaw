import type { ResolvedWempAccount } from "./types.js";

export function resolvePairedAgent(account: ResolvedWempAccount): string {
  return account.routing.pairedAgent || "main";
}

export function resolveUnpairedAgent(account: ResolvedWempAccount): string {
  return account.routing.unpairedAgent || "wemp-kf";
}
