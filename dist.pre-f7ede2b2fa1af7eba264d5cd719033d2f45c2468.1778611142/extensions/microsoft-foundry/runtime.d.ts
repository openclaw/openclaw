import { dn as ProviderPrepareRuntimeAuthContext } from "../../types-DKA4S1yN.js";
//#region extensions/microsoft-foundry/runtime.d.ts
declare function resetFoundryRuntimeAuthCaches(): void;
declare function prepareFoundryRuntimeAuth(ctx: ProviderPrepareRuntimeAuthContext): Promise<{
  baseUrl?: string | undefined;
  apiKey: string;
  expiresAt: number;
} | null>;
//#endregion
export { prepareFoundryRuntimeAuth, resetFoundryRuntimeAuthCaches };