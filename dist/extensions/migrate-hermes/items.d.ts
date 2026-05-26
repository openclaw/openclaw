import { l as MigrationItem } from "../../types-Vx7Jq4_-2.js";
//#region extensions/migrate-hermes/items.d.ts
declare const HERMES_REASON_ALREADY_CONFIGURED = "already configured";
declare const HERMES_REASON_DEFAULT_MODEL_CONFIGURED = "default model already configured";
declare const HERMES_REASON_INCLUDE_SECRETS = "use --include-secrets to import";
declare const HERMES_REASON_AUTH_PROFILE_EXISTS = "auth profile exists";
declare const HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE = "config runtime unavailable";
declare const HERMES_REASON_MISSING_SECRET_METADATA = "missing secret metadata";
declare const HERMES_REASON_SECRET_NO_LONGER_PRESENT = "secret no longer present";
declare const HERMES_REASON_AUTH_PROFILE_WRITE_FAILED = "failed to write auth profile";
declare function createHermesModelItem(params: {
  model: string;
  currentModel?: string;
  overwrite?: boolean;
}): MigrationItem;
declare function readHermesModelDetails(item: MigrationItem): {
  model: string;
} | undefined;
declare function createHermesSecretItem(params: {
  id: string;
  source?: string;
  target: string;
  includeSecrets?: boolean;
  existsAlready?: boolean;
  details: {
    envVar: string;
    provider: string;
    profileId: string;
  };
}): MigrationItem;
declare function readHermesSecretDetails(item: MigrationItem): {
  envVar: string;
  provider: string;
  profileId: string;
} | undefined;
declare function hermesItemConflict(item: MigrationItem, reason: string): MigrationItem;
declare function hermesItemError(item: MigrationItem, reason: string): MigrationItem;
declare function hermesItemSkipped(item: MigrationItem, reason: string): MigrationItem;
//#endregion
export { HERMES_REASON_ALREADY_CONFIGURED, HERMES_REASON_AUTH_PROFILE_EXISTS, HERMES_REASON_AUTH_PROFILE_WRITE_FAILED, HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE, HERMES_REASON_DEFAULT_MODEL_CONFIGURED, HERMES_REASON_INCLUDE_SECRETS, HERMES_REASON_MISSING_SECRET_METADATA, HERMES_REASON_SECRET_NO_LONGER_PRESENT, createHermesModelItem, createHermesSecretItem, hermesItemConflict, hermesItemError, hermesItemSkipped, readHermesModelDetails, readHermesSecretDetails };