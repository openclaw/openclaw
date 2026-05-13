import fs from "node:fs";
import path from "node:path";
import { saveMatrixCredentialsState } from "./matrix/credentials-read.js";

export const MATRIX_TEST_HOMESERVER = "https://matrix.example.org";
export const MATRIX_DEFAULT_USER_ID = "@bot:example.org";
export const MATRIX_DEFAULT_ACCESS_TOKEN = "tok-123";
export const MATRIX_DEFAULT_DEVICE_ID = "DEVICE123";
export const MATRIX_OPS_ACCOUNT_ID = "ops";
export const MATRIX_OPS_USER_ID = "@ops-bot:example.org";
export const MATRIX_OPS_ACCESS_TOKEN = "tok-ops";
export const MATRIX_OPS_DEVICE_ID = "DEVICEOPS";

export function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

export function writeMatrixCredentials(
  stateDir: string,
  params?: {
    accountId?: string;
    homeserver?: string;
    userId?: string;
    accessToken?: string;
    deviceId?: string;
  },
) {
  const accountId = params?.accountId ?? MATRIX_OPS_ACCOUNT_ID;
  saveMatrixCredentialsState(
    {
      homeserver: params?.homeserver ?? MATRIX_TEST_HOMESERVER,
      userId: params?.userId ?? MATRIX_OPS_USER_ID,
      accessToken: params?.accessToken ?? MATRIX_OPS_ACCESS_TOKEN,
      deviceId: params?.deviceId ?? MATRIX_OPS_DEVICE_ID,
      createdAt: "2026-03-12T00:00:00.000Z",
      lastUsedAt: "2026-03-12T00:00:00.000Z",
    },
    { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    accountId,
  );
}
