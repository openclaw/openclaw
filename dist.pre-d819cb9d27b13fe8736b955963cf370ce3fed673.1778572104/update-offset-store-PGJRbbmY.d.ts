//#region extensions/telegram/src/update-offset-store.d.ts
declare function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number | null>;
declare function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void>;
declare function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void>;
//#endregion
export { readTelegramUpdateOffset as n, writeTelegramUpdateOffset as r, deleteTelegramUpdateOffset as t };