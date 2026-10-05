// Keep credential failure identity usable without loading credential or process runtime.
export type LookupClientDiagnostic = {
  lookupId: string;
  clientStage: string;
  clientCode: string;
  httpStatus?: number;
};

export class GitHubCredentialLookupError extends Error {
  override name = "GitHubCredentialLookupError";

  constructor(readonly diagnostic: Readonly<LookupClientDiagnostic>) {
    super(
      diagnostic.clientStage === "broker"
        ? `GitHub credential broker rejected this lookup (HTTP ${diagnostic.httpStatus}); access was not established. Inspect the credential service diagnostic before retrying.`
        : `GitHub credential lookup failed (${diagnostic.clientStage}/${diagnostic.clientCode}); inspect the credential service diagnostic before retrying.`,
    );
  }
}
