import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import type { LegacyAuthProfileSource } from "./legacy-source-files.js";
import type { AuthProfileDatabase } from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

export type LoadAuthProfileStoreOptions = {
  /** Limit a credential-read refusal to the provider being resolved; writes stay owner-wide. */
  migrationProvider?: string;
  deferScopedMigrationRefusals?: boolean;
  onReadOwner?: (owner: AuthProfileReadOwner) => void;
  /** Materialize only this explicitly selected personal account into the returned view. */
  profileId?: string;
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  database?: AuthProfileDatabase;
  externalCli?: ExternalCliAuthDiscovery;
  inheritedAuthDir?: string;
  readOnly?: boolean;
  syncExternalCli?: boolean;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

export type AuthProfileReadOwner = {
  databasePath: string;
  candidates: LegacyAuthProfileSource[];
  readStore: () => AuthProfileStore | null;
};

export type PreparedAuthProfileStoreReads = {
  effectiveAgentDir: string | undefined;
  env: NodeJS.ProcessEnv;
  options: LoadAuthProfileStoreOptions;
  runInCapturedScope: <T>(operation: () => T) => T;
  sharedPath: () => Promise<string>;
  readStore: (
    ownerAgentDir: string | undefined,
    options: LoadAuthProfileStoreOptions,
  ) => Promise<AuthProfileStore>;
  assertCurrent: () => void;
  materializePersonalProfile: (store: AuthProfileStore) => Promise<AuthProfileStore>;
};
