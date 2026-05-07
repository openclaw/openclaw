import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildIMessageWatchSubscribeParams,
  readIMessageCatchupCursor,
  recordIMessageCatchupCursor,
} from "./catchup-cursor.js";

describe("iMessage catchup cursor", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-catchup-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists the largest processed rowid per account", async () => {
    const filePath = path.join(tmpDir, "cursors.json");

    await recordIMessageCatchupCursor({ accountId: "main", messageId: 41, filePath });
    await recordIMessageCatchupCursor({ accountId: "main", messageId: 40, filePath });
    await recordIMessageCatchupCursor({ accountId: "work", messageId: 7, filePath });

    await expect(readIMessageCatchupCursor({ accountId: "main", filePath })).resolves.toMatchObject(
      {
        lastSeenRowid: 41,
      },
    );
    await expect(readIMessageCatchupCursor({ accountId: "work", filePath })).resolves.toMatchObject(
      {
        lastSeenRowid: 7,
      },
    );
  });

  it("builds a bounded imsg watch resume request from a saved cursor", () => {
    const params = buildIMessageWatchSubscribeParams({
      attachments: true,
      cursor: {
        lastSeenRowid: 9000,
        updatedAt: "2026-05-07T00:00:00.000Z",
      },
      catchup: {
        maxAgeMinutes: 30,
      },
      now: new Date("2026-05-07T12:00:00.000Z"),
    });

    expect(params).toEqual({
      attachments: true,
      since_rowid: 9000,
      start: "2026-05-07T11:30:00.000Z",
    });
  });

  it("keeps first-run watch subscriptions live-only", () => {
    expect(
      buildIMessageWatchSubscribeParams({
        attachments: false,
        cursor: null,
      }),
    ).toEqual({
      attachments: false,
    });
  });
});
