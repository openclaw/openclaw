import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { WorkboardDispatchResult } from "./store-inputs.js";

export function redactClaimToken(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  if (!claim) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      claim: {
        ...claim,
        token: "[redacted]",
      },
    },
  };
}

export function redactDispatchResult<T extends WorkboardDispatchResult>(
  result: T,
  redactCard = redactClaimToken,
): T {
  return {
    ...result,
    promoted: result.promoted.map(redactCard),
    reclaimed: result.reclaimed.map(redactCard),
    blocked: result.blocked.map(redactCard),
    orchestrated: result.orchestrated.map(redactCard),
  };
}
