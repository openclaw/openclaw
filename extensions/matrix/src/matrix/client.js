import { isBunRuntime } from "./client/runtime.js";
import {
  resolveMatrixConfig,
  resolveMatrixConfigForAccount,
  resolveMatrixAuth
} from "./client/config.js";
import { createMatrixClient } from "./client/create-client.js";
import {
  resolveSharedMatrixClient,
  waitForMatrixSync,
  stopSharedClient,
  stopSharedClientForAccount
} from "./client/shared.js";
export {
  createMatrixClient,
  isBunRuntime,
  resolveMatrixAuth,
  resolveMatrixConfig,
  resolveMatrixConfigForAccount,
  resolveSharedMatrixClient,
  stopSharedClient,
  stopSharedClientForAccount,
  waitForMatrixSync
};
