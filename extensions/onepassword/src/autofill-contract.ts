/** 1Password's opaque-reference API; only the adapter may enter a browser. */
export type ExtResult<T> =
  | { success: true; result: T }
  | { success: false; error: { code: string } };

export type LoginEntryInput = {
  type: "login";
  parameters: { website: string };
  reason?: string;
  keywords?: string[];
};
export type AccessRequestInput = { version: 2; goal: string; entries: LoginEntryInput[] };
export type AccessRequest = Omit<AccessRequestInput, "entries"> & {
  id: string;
  path: string;
  identity: string;
  state: string;
  createdAt: string;
  entries: Array<LoginEntryInput & { id: string }>;
};
export type AccessRequestStatus = {
  path: string;
  state: string;
  resolved: Array<{ entryId?: string; reference: string }>;
};

/** Private viewer projection: request metadata and an ephemeral native-app link, never credentials. */
export type AutofillApprovalSnapshot = {
  state: string;
  appLink?: string;
  expiresAt?: number;
  openedAt?: number;
  deadline?: number;
  goal?: string;
  entries?: Array<{ domain: string; reason?: string; granted?: boolean }>;
  code?: string;
};

/** Adapter must enable Agentic Mode and exclusively lock the tab during fill. */
export interface AgenticAutofillExtension {
  readiness?(): Promise<ExtResult<{ status: "ready" }>>;
  createAccessRequest(p: {
    accessToken: string;
    integrationKey: string;
    requests: AccessRequestInput;
  }): Promise<ExtResult<{ accessRequest: AccessRequest; appLink: string }>>;
  getAccessRequestStatus(p: {
    accessToken: string;
    integrationKey: string;
    accessRequestUUID: string;
  }): Promise<ExtResult<AccessRequestStatus>>;
  fillCredential(p: {
    accessToken: string;
    integrationKey: string;
    resourcePath: string;
    tab: { targetId: string; profile?: string };
  }): Promise<ExtResult<{ status: "fill_submitted" }>>;
}
