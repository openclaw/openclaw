import type { SqliteAuthSchema } from "../../infra/sqlite-readonly-auth-schema.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type { OpenClawStateWorkerErrorPayload } from "../../state/openclaw-state-worker-error.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
  AuthProfileStoreOwner,
  OAuthCredential,
  SharedAuthStoreOwnership,
} from "./types.js";
import type {
  PersonalAuthProfileUsageReduction,
  PersonalAuthProfileUsageResult,
} from "./usage-reduction.js";

export type AuthProfileReadSource =
  | { kind: "shared-state"; databasePath: string }
  | {
      kind: "agent";
      databasePath: string;
      agentId: string;
      identity: string | undefined;
      schema: SqliteAuthSchema | undefined;
    };

export type AuthProfileUsageInput = {
  profileId: string;
  reduction: PersonalAuthProfileUsageReduction;
  inherited: boolean;
  providerKey?: string;
  providerAliases?: Record<string, string>;
  expectedCredential: AuthProfileCredential | undefined;
  scopedSharedStore?: AuthProfileStore;
};

export type AuthProfileUsageReceipt = {
  store: AuthProfileStore;
  result: PersonalAuthProfileUsageResult | undefined;
  publication: {
    credentialsChanged: boolean;
    profileSetChanged: boolean;
    stateChanged: boolean;
    selectionChanged: boolean;
    profileIds: string[];
  };
};

export function createAuthProfileUsageReceipt(store: AuthProfileStore): AuthProfileUsageReceipt {
  return {
    store,
    result: undefined,
    publication: {
      credentialsChanged: false,
      profileSetChanged: false,
      stateChanged: false,
      selectionChanged: false,
      profileIds: [],
    },
  };
}

export type AuthProfileUsageResult =
  | { ok: true; receipt: AuthProfileUsageReceipt }
  | { ok: false; error: OpenClawStateWorkerErrorPayload };

export type AuthStoreUpdateInput = {
  owner: AuthProfileStoreOwner;
  agentDir?: string;
  envOnly: boolean;
  peerGeneration?: { profileId: string; generation: OAuthCredential };
};

export type AuthStoreUpdatePublication = AuthProfileUsageReceipt["publication"];

export type AuthStoreUpdateOperations = {
  "authProfiles.update": { input: AuthStoreUpdateInput; output: boolean };
};

export type AuthProfileBootstrapInput = {
  sourcePath: string;
  sourceIdentity?: DatabasePathIdentity;
  legacySourcePaths: string[];
};

export type AuthProfileBootstrapResult = {
  ownership: SharedAuthStoreOwnership;
  relocated: boolean;
};
