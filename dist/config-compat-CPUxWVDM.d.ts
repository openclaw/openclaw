import fs from "node:fs";
import path from "node:path";
import os from "node:os";

//#region extensions/elevenlabs/config-compat.d.ts
type ElevenLabsApiKeyDeps = {
  fs?: typeof fs;
  os?: typeof os;
  path?: typeof path;
};
declare const ELEVENLABS_TALK_PROVIDER_ID = "elevenlabs";
declare function migrateElevenLabsLegacyTalkConfig<T>(raw: T): {
  config: T;
  changes: string[];
};
declare function resolveElevenLabsApiKeyWithProfileFallback(env?: NodeJS.ProcessEnv, deps?: ElevenLabsApiKeyDeps): string | null;
//#endregion
export { migrateElevenLabsLegacyTalkConfig as n, resolveElevenLabsApiKeyWithProfileFallback as r, ELEVENLABS_TALK_PROVIDER_ID as t };