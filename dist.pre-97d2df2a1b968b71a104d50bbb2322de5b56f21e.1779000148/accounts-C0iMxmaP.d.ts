import { t as MatrixConfig } from "./types-Ce_-JxxH.js";

//#region extensions/matrix/src/matrix/accounts.d.ts
type ResolvedMatrixAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  homeserver?: string;
  userId?: string;
  config: MatrixConfig;
};
//#endregion
export { ResolvedMatrixAccount as t };