import { haveSameOperatorRunSource } from "../../gateway/operator-run-authority.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";

export type RequesterUserTurnSource = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
};

/** Only an attested live original source can survive another direct admission. */
export function haveSameRequesterUserTurnSource(
  original: RequesterUserTurnSource,
  incoming: RequesterUserTurnSource,
): boolean {
  if (!original.operatorAuthority || !incoming.operatorAuthority) {
    return false;
  }
  try {
    return haveSameOperatorRunSource(original.operatorAuthority, incoming.operatorAuthority);
  } catch {
    // A matching profile cannot resurrect a retired source.
    return false;
  }
}
