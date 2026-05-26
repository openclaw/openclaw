import { dn as ProviderPrepareRuntimeAuthContext } from "../../types-lCXG2pW_.js";
//#region extensions/microsoft-foundry/runtime.d.ts
declare function resetFoundryRuntimeAuthCaches(): void;
declare function prepareFoundryRuntimeAuth(ctx: ProviderPrepareRuntimeAuthContext): Promise<{
  baseUrl?: string | undefined;
  apiKey: string;
  expiresAt: number;
} | null>;
//#endregion
export { prepareFoundryRuntimeAuth, resetFoundryRuntimeAuthCaches };