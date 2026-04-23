export {
  buildSecretInputSchema,
  coerceSecretRef,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";

import { coerceSecretRef, normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";

export function hasMatchingSecretInput(left: unknown, right: unknown): boolean {
  const leftString = normalizeSecretInputString(left);
  const rightString = normalizeSecretInputString(right);
  if (leftString && rightString) {
    return leftString === rightString;
  }

  const leftRef = coerceSecretRef(left);
  const rightRef = coerceSecretRef(right);
  if (!leftRef || !rightRef) {
    return false;
  }

  return (
    leftRef.source === rightRef.source &&
    leftRef.provider === rightRef.provider &&
    leftRef.id === rightRef.id
  );
}
