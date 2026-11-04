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

/** Private connect-card projection: the public consent link and code, never pickup secrets. */
export type AutofillConnectSnapshot = {
  state: string;
  connectUrl?: string;
  confirmationCode?: string;
  expiresAt?: number;
  openedAt?: number;
  code?: string;
};
