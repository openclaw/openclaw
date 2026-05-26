import { i as AuthProfileCredential, s as AuthProfileStore } from "./types-BwDj5PsX.js";

//#region src/agents/auth-profiles/profile-list.d.ts
declare function dedupeProfileIds(profileIds: string[]): string[];
declare function listProfilesForProvider(store: AuthProfileStore, provider: string): string[];
//#endregion
//#region src/agents/auth-profiles/profiles.d.ts
declare function setAuthProfileOrder(params: {
  agentDir?: string;
  provider: string;
  order?: string[] | null;
}): Promise<AuthProfileStore | null>;
declare function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): void;
declare function upsertAuthProfileWithLock(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): Promise<AuthProfileStore | null>;
declare function removeProviderAuthProfilesWithLock(params: {
  provider: string;
  agentDir?: string;
}): Promise<AuthProfileStore | null>;
declare function markAuthProfileSuccess(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<void>;
//#endregion
export { upsertAuthProfileWithLock as a, upsertAuthProfile as i, removeProviderAuthProfilesWithLock as n, dedupeProfileIds as o, setAuthProfileOrder as r, listProfilesForProvider as s, markAuthProfileSuccess as t };