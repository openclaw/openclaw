import { createSubsystemLogger } from "../../logging/subsystem.js";

export const AUTH_STORE_VERSION = 1;
export const AUTH_PROFILE_FILENAME = "auth-profiles.json";
export const LEGACY_AUTH_FILENAME = "auth.json";

export const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
export const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";

export const AUTH_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

export const log = createSubsystemLogger("agents/auth-profiles");
