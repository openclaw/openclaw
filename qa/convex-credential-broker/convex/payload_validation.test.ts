import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeCredentialPayloadForKind } from "./payload_validation.js";

const primaryArchive = "YQ==";
const guestArchive = "Yg==";

function buildTelegramTestUserbotPayload() {
  return {
    schemaVersion: 1,
    environment: "test",
    groupId: "-1001",
    forumGroupId: "-1002",
    forumTopicId: 42,
    sutToken: "test-token",
    sutUsername: "test_bot",
    sutBotId: "700000001",
    testerUserId: "700000002",
    tdlibArchiveBase64: primaryArchive,
    tdlibArchiveSha256: "a".repeat(64),
    tdlibVersion: "1.8.67",
    participants: [
      {
        alias: "guest",
        testerUserId: "700000003",
        tdlibArchiveBase64: guestArchive,
        tdlibArchiveSha256: "b".repeat(64),
        tdlibVersion: "1.8.67",
      },
    ],
  };
}

describe("Telegram Test Server credential payload validation", () => {
  it("retains a validated forum topic and distinct participant sessions", () => {
    const normalized = normalizeCredentialPayloadForKind(
      "telegram-test-userbot",
      buildTelegramTestUserbotPayload(),
    );
    assert.deepEqual(
      {
        forumGroupId: normalized.forumGroupId,
        forumTopicId: normalized.forumTopicId,
        participants: normalized.participants,
      },
      {
        forumGroupId: "-1002",
        forumTopicId: 42,
        participants: [
          {
            alias: "guest",
            testerUserId: "700000003",
            tdlibArchiveBase64: guestArchive,
            tdlibArchiveSha256: "b".repeat(64),
            tdlibVersion: "1.8.67",
          },
        ],
      },
    );
  });

  it("rejects invalid forum selectors and duplicate participant authority", () => {
    assert.throws(
      () =>
        normalizeCredentialPayloadForKind("telegram-test-userbot", {
          ...buildTelegramTestUserbotPayload(),
          forumTopicId: 0,
        }),
      /invalid forumTopicId/u,
    );
    assert.throws(
      () =>
        normalizeCredentialPayloadForKind("telegram-test-userbot", {
          ...buildTelegramTestUserbotPayload(),
          participants: [
            {
              ...buildTelegramTestUserbotPayload().participants[0],
              testerUserId: "700000002",
            },
          ],
        }),
      /distinct participant identities/u,
    );
  });
});
