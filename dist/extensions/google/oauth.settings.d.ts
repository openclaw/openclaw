import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

//#region extensions/google/oauth.settings.d.ts
type OAuthSettingsFs = {
  existsSync: (path: Parameters<typeof existsSync>[0]) => ReturnType<typeof existsSync>;
  readFileSync: (path: Parameters<typeof readFileSync>[0], encoding: "utf8") => string;
  homedir: typeof homedir;
};
declare function setOAuthSettingsFsForTest(overrides?: Partial<OAuthSettingsFs>): void;
declare function resolveGeminiCliSelectedAuthType(): string | undefined;
declare function isGeminiCliPersonalOAuth(): boolean;
//#endregion
export { isGeminiCliPersonalOAuth, resolveGeminiCliSelectedAuthType, setOAuthSettingsFsForTest };