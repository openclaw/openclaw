import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isCodexManagedRequirementsSemanticFingerprint } from "./managed-requirements-identity.js";

type ScheduledCodexAppPreparedProfileAuth = {
  kind?: undefined;
  profileId: string;
  accountId: string;
};
type ScheduledCodexAppConfiguredServerAuth = {
  kind: "configured-app-server";
  connectionFingerprint: string;
  managedRequirementsFingerprint: string;
  managedRequirementsSemanticFingerprint?: string;
};
export type ScheduledCodexAppAuthorityAuth =
  | ScheduledCodexAppPreparedProfileAuth
  | ScheduledCodexAppConfiguredServerAuth;

export function parseScheduledCodexAppAuthorityAuth(
  value: unknown,
): ScheduledCodexAppAuthorityAuth | undefined {
  const auth = asOptionalRecord(value);
  const profileId = normalizeOptionalString(auth?.profileId);
  const connectionFingerprint = normalizeOptionalString(auth?.connectionFingerprint);
  const managedRequirementsFingerprint = normalizeOptionalString(
    auth?.managedRequirementsFingerprint,
  );
  const semanticFingerprint = auth?.managedRequirementsSemanticFingerprint;
  if (
    auth?.kind === "configured-app-server" &&
    Object.hasOwn(auth, "managedRequirementsSemanticFingerprint") &&
    !isCodexManagedRequirementsSemanticFingerprint(semanticFingerprint)
  ) {
    throw new Error(
      "Unsupported Codex managed requirements identity; reauthorize this automation.",
    );
  }
  const accountId = normalizeOptionalString(auth?.accountId);
  return auth?.kind === "configured-app-server" &&
    connectionFingerprint &&
    managedRequirementsFingerprint
    ? {
        kind: "configured-app-server",
        connectionFingerprint,
        managedRequirementsFingerprint,
        ...(isCodexManagedRequirementsSemanticFingerprint(semanticFingerprint)
          ? { managedRequirementsSemanticFingerprint: semanticFingerprint }
          : {}),
      }
    : auth?.kind === undefined && profileId && accountId
      ? { profileId, accountId }
      : undefined;
}
