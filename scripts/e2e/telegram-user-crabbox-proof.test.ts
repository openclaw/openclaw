// Test for writeSutConfig: the mock SUT config used by Mantis telegram-desktop-proof
// MUST opt the new account in to rich-message routing, otherwise the proof capture
// shows the raw HTML / pipe-table markup as plain text instead of native Telegram
// rich rendering.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import { writeSutConfig } from "./telegram-user-crabbox-proof.ts";

test("writeSutConfig enables richMessages and richMessagesAutoDetect for the mock Telegram SUT", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-crabbox-sut-test-"));
  try {
    const result = writeSutConfig({
      gatewayPort: 19879,
      groupId: "1",
      mockPort: 19882,
      outputDir: tempRoot,
      testerId: "1001",
    });
    const config = JSON.parse(fs.readFileSync(result.configPath, "utf8")) as {
      channels: { telegram: { richMessages?: boolean; richMessagesAutoDetect?: boolean } };
    };
    assert.equal(
      config.channels.telegram.richMessages,
      true,
      "channels.telegram.richMessages must be true so the mock SUT exercises the new auto-routing path",
    );
    assert.equal(
      config.channels.telegram.richMessagesAutoDetect,
      true,
      "channels.telegram.richMessagesAutoDetect must be true so the mock SUT routes detected rich content through sendRichMessage",
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
