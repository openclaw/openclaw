import { gn as ProviderPrepareRuntimeAuthContext } from "../../types-D0OCNFd4.js";
//#region extensions/microsoft-foundry/runtime.d.ts
declare function resetFoundryRuntimeAuthCaches(): void;
declare function prepareFoundryRuntimeAuth(ctx: ProviderPrepareRuntimeAuthContext): Promise<{
  baseUrl?: string | undefined;
  apiKey: string;
  expiresAt: number;
} | null>;
//#endregion
export { prepareFoundryRuntimeAuth, resetFoundryRuntimeAuthCaches };