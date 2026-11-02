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

/** Adapter must enable Agentic Mode and exclusively lock the tab during fill. */
export interface AgenticAutofillExtension {
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

/** Opaque link delivery must never mirror content into transcripts, model context or logs. */
export interface AutofillApprovalDelivery {
  deliver(appLink: string): Promise<"sent" | "unsupported">;
}

/** Fail closed until the browser-plugin ExtensionBridge adapter is installed here. */
export const unavailableAutofillExtension: AgenticAutofillExtension = {
  async createAccessRequest() {
    return { success: false, error: { code: "extensionAdapterUnavailable" } };
  },
  async getAccessRequestStatus() {
    return { success: false, error: { code: "extensionAdapterUnavailable" } };
  },
  async fillCredential() {
    return { success: false, error: { code: "extensionAdapterUnavailable" } };
  },
};

/** Normal plugin text delivery mirrors into history and is NOT a sensitive-link transport. */
export const unavailableApprovalDelivery: AutofillApprovalDelivery = {
  async deliver() {
    return "unsupported";
  },
};
