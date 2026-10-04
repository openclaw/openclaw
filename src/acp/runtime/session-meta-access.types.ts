import type { IncognitoSessionAuthority } from "../../config/sessions/session-incognito-contract.js";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AcpSessionControlBinding } from "./session-meta-control.types.js";

export type AcpSessionMetaMutationFields = {
  expectedControlBinding?: AcpSessionControlBinding;
  now?: () => number;
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined;
};

export type IncognitoAcpSessionReadParams = {
  authority: IncognitoSessionAuthority;
  sessionKey: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  databasePath?: string;
};

export type IncognitoAcpSessionMutationParams = IncognitoAcpSessionReadParams &
  AcpSessionMetaMutationFields;

/** The actor owns lifetime; these contracts do not load either persistence implementation. */
export type IncognitoAcpSessionAccess = {
  readEntry(params: IncognitoAcpSessionReadParams): Promise<SessionEntry | undefined>;
  upsertMeta(params: IncognitoAcpSessionMutationParams): Promise<SessionEntry | null>;
};
