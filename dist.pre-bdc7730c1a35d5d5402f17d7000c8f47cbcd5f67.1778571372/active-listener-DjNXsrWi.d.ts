import { i as OpenClawConfig } from "./types.openclaw-BdZr8Ncl.js";
import { t as ActiveWebListener } from "./types-ByKZyVG5.js";

//#region extensions/whatsapp/src/active-listener.d.ts
declare function resolveWebAccountId(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string;
declare function getActiveWebListener(accountId: string): ActiveWebListener | null;
//#endregion
export { resolveWebAccountId as n, getActiveWebListener as t };