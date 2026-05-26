import type { ConfigUiHint } from "../config-ui-hints-types.js";
export declare const SENSITIVE_URL_HINT_TAG = "url-secret";
export declare function isSensitiveUrlQueryParamName(name: string): boolean;
export declare function isSensitiveUrlConfigPath(path: string): boolean;
export declare function hasSensitiveUrlHintTag(hint: Pick<ConfigUiHint, "tags"> | undefined): boolean;
export declare function redactSensitiveUrl(value: string): string;
export declare function redactSensitiveUrlLikeString(value: string): string;
