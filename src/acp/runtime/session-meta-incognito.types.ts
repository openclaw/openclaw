import type { IncognitoSessionAuthority } from "../../config/sessions/session-incognito-contract.js";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AcpSessionControlBinding } from "./session-meta-control.types.js";

export type IncognitoAcpSessionParams = {
  authority: IncognitoSessionAuthority;
  sessionKey: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  databasePath?: string;
};

export type IncognitoAcpSessionMutation = {
  expectedControlBinding?: AcpSessionControlBinding;
  now?: () => number;
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined;
};

export type IncognitoAcpSessionAccess = {
  readEntry(params: IncognitoAcpSessionParams): Promise<SessionEntry | undefined>;
  upsertMeta(
    params: IncognitoAcpSessionParams & IncognitoAcpSessionMutation,
  ): Promise<SessionEntry | null>;
};
