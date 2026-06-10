import fs from "node:fs";
import path from "node:path";
import {
  HUB_OWNER_A,
  delegateSessionKey,
  hubDelegatedEntry,
} from "../../../test/helpers/hub-delegated-fixtures.js";
import { writeSessionStoreForTest } from "../../config/sessions/test-helpers.js";
import type { SessionEntry } from "../../config/sessions/types.js";

export { HUB_OWNER_A, delegateSessionKey, hubDelegatedEntry };

export function writeDelegateStore(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  writeSessionStoreForTest(storePath, { [sessionKey]: entry });
}

export function defaultDelegateEntry(label = "refactor"): SessionEntry {
  return hubDelegatedEntry({
    ownerSessionKey: HUB_OWNER_A,
    label,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}
