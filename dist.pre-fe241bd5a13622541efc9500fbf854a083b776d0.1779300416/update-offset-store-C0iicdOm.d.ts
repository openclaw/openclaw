//#region extensions/telegram/src/update-offset-store.d.ts
type TelegramOffsetRotationReason = "bot-id-changed" | "token-rotated" | "legacy-state";
type TelegramUpdateOffsetRotationInfo = {
  reason: TelegramOffsetRotationReason;
  previousBotId: string | null;
  currentBotId: string;
  staleLastUpdateId: number;
};
declare function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
  onRotationDetected?: (info: TelegramUpdateOffsetRotationInfo) => void | Promise<void>;
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