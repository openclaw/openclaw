import type { OpenClawStateWorkerErrorPayload } from "../../state/openclaw-state-worker-error.js";
import type { AuthProfileRowRead, AuthProfileStore, UserModelAuthProfile } from "./types.js";
import type {
  PersonalAuthProfileUsageReduction,
  PersonalAuthProfileUsageResult,
} from "./usage-reduction.js";

export type AuthProfileUsageInput = {
  profileId: string;
  reduction: PersonalAuthProfileUsageReduction;
  inherited: boolean;
  providerKey?: string;
  providerAliases?: Record<string, string>;
  expectedCredentials: unknown;
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

export type AuthProfileWorkerOperations = {
  "authProfiles.usage": { input: AuthProfileUsageInput; output: AuthProfileUsageResult };
  "authProfiles.personalUsage": {
    input: { profileId: string; reduction: PersonalAuthProfileUsageReduction };
    output: PersonalAuthProfileUsageResult | undefined;
  };
  "authProfiles.read": {
    input: { artifactPreserving: boolean };
    output: AuthProfileRowRead;
  };
  "authProfiles.sharedOwnership": {
    input: { artifactPreserving: boolean };
    output: unknown;
  };
  "authProfiles.personal": {
    input: { profileId: string; artifactPreserving: boolean };
    output: UserModelAuthProfile | undefined;
  };
};
