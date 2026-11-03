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
