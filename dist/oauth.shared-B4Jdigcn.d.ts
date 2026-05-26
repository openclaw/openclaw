//#region extensions/google/oauth.shared.d.ts
declare const CLIENT_ID_KEYS: string[];
declare const CLIENT_SECRET_KEYS: string[];
declare const REDIRECT_URI = "http://localhost:8085/oauth2callback";
declare const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
declare const TOKEN_URL = "https://oauth2.googleapis.com/token";
declare const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
declare const CODE_ASSIST_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
declare const LOAD_CODE_ASSIST_ENDPOINTS: string[];
declare const DEFAULT_FETCH_TIMEOUT_MS = 10000;
declare const SCOPES: string[];
declare const TIER_FREE = "free-tier";
declare const TIER_LEGACY = "legacy-tier";
declare const TIER_STANDARD = "standard-tier";
type GeminiCliOAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId?: string;
};
type GeminiCliOAuthContext = {
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  log: (msg: string) => void;
  note: (message: string, title?: string) => Promise<void>;
  prompt: (message: string) => Promise<string>;
  progress: {
    update: (msg: string) => void;
    stop: (msg?: string) => void;
  };
};
//#endregion
export { DEFAULT_FETCH_TIMEOUT_MS as a, LOAD_CODE_ASSIST_ENDPOINTS as c, TIER_FREE as d, TIER_LEGACY as f, USERINFO_URL as h, CODE_ASSIST_ENDPOINT_PROD as i, REDIRECT_URI as l, TOKEN_URL as m, CLIENT_ID_KEYS as n, GeminiCliOAuthContext as o, TIER_STANDARD as p, CLIENT_SECRET_KEYS as r, GeminiCliOAuthCredentials as s, AUTH_URL as t, SCOPES as u };