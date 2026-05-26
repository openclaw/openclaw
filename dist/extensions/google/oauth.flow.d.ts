import { r as generateOAuthState } from "../../provider-auth-runtime-ByT9yRat.js";

//#region extensions/google/oauth.flow.d.ts
declare function shouldUseManualOAuthFlow(isRemote: boolean): boolean;
declare function generatePkce(): {
  verifier: string;
  challenge: string;
};
declare function buildAuthUrl(challenge: string, state: string): string;
declare function parseCallbackInput(input: string): {
  code: string;
  state: string;
} | {
  error: string;
};
declare function waitForLocalCallback(params: {
  expectedState: string;
  timeoutMs: number;
  onProgress?: (message: string) => void;
}): Promise<{
  code: string;
  state: string;
}>;
//#endregion
export { buildAuthUrl, generateOAuthState, generatePkce, parseCallbackInput, shouldUseManualOAuthFlow, waitForLocalCallback };