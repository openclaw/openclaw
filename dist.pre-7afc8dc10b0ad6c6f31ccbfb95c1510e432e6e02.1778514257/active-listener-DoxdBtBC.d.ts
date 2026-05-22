import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { t as ActiveWebListener } from "./types-BqeYEFt1.js";

//#region extensions/whatsapp/src/active-listener.d.ts
declare function resolveWebAccountId(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string;
declare function getActiveWebListener(accountId: string): ActiveWebListener | null;
//#endregion
export { resolveWebAccountId as n, getActiveWebListener as t };