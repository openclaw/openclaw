import { describe, it } from "vitest";
import {
  validateChatSendParams,
  validateMentionsChangedEvent,
  validateMentionsDismissParams,
  validateMentionsListParams,
  validateMentionsListResult,
  validateSessionsCreateParams,
  validateSessionsSendParams,
  validateUsersMentionableParams,
  validateUsersMentionableResult,
} from "../index.js";
import { copies, validation } from "./protocol-validation.test-support.js";

const directory = validation(validateUsersMentionableParams);
const users = validation(validateUsersMentionableResult);
const list = validation(validateMentionsListParams);
const dismiss = validation(validateMentionsDismissParams);
const inbox = validation(validateMentionsListResult);
const changed = validation(validateMentionsChangedEvent);

describe("human mention protocol", () => {
  it.each([
    ["chat.send", validateChatSendParams, { sessionKey: "agent:main:main" }],
    ["sessions.create", validateSessionsCreateParams, { agentId: "main" }],
    ["sessions.send", validateSessionsSendParams, { key: "agent:main:main" }],
  ] as const)("preserves bounded mentions on %s", (_method, validate, target) => {
    const method = validation(validate);
    const base = { ...target, message: "🙂 @Ada", idempotencyKey: "run-mentions" };
    const mention = { profileId: "profile-ada", start: 3, end: 7 };
    method.accepts(base, { ...base, mentions: [] }, { ...base, mentions: [mention] });
    method.rejects(
      ...[
        ["profile-ada"],
        [{ ...mention, profileId: "" }],
        [{ ...mention, profileId: "x".repeat(257) }],
        [{ ...mention, start: -1 }],
        [{ ...mention, start: 3.5 }],
        [{ ...mention, end: 0 }],
        [{ ...mention, senderProfileId: "forged-sender" }],
        copies(mention, 11),
      ].map((mentions) => Object.assign({}, base, { mentions })),
    );
  });
  it("requires an existing or prospective directory context", () => {
    directory.accepts(
      { sessionKey: "agent:main:discussion" },
      { sessionKey: "agent:main:discussion", query: "Ada" },
      { sessionKey: "global", agentId: "main" },
      { agentId: "main" },
      { agentId: "main", visibility: "draft", query: "" },
    );
    directory.rejects(
      {},
      { query: "Ada" },
      { sessionKey: "agent:main:discussion", visibility: "shared" },
      { agentId: "main", visibility: "private" },
      { agentId: "main", profileId: "another-profile" },
      { agentId: "main", query: "x".repeat(129) },
      { sessionKey: "" },
    );
  });
  it("bounds directory results and excludes private profile fields", () => {
    const user = { profileId: "profile-ada", displayName: "Ada", online: false };
    users.accepts({ users: [user], truncated: false });
    users.rejects(
      { users: [{ ...user, emails: ["ada@example.com"] }], truncated: false },
      { users: copies(user, 101), truncated: true },
    );
  });
  it("keeps listing self-only and dismissals explicit and bounded", () => {
    list.accepts({});
    list.rejects({ profileId: "another-profile" });
    dismiss.accepts({ ids: ["mention-1", "mention-2"] }, { ids: [] });
    dismiss.rejects(
      { ids: ["mention-1"], profileId: "another-profile" },
      { ids: ["mention-1", "mention-1"] },
      { ids: [""] },
      { ids: Array.from({ length: 101 }, (_, index) => `mention-${index}`) },
      { all: true },
    );
  });
  it("bounds inbox snapshots and keeps invalidations content-free", () => {
    const version = { gatewayInstanceId: "gateway-instance", revision: 3 };
    const item = {
      id: "mention-1",
      senderProfileId: "profile-ada",
      senderLabel: "Ada",
      sessionKey: "agent:main:discussion",
      agentId: "main",
      sessionTitle: "Discussion",
      messageId: "message-1",
      createdAt: 1,
      expiresAt: 60_001,
    };
    inbox.accepts({ ...version, items: [item] });
    inbox.rejects(
      { ...version, items: [{ ...item, excerpt: "x".repeat(281) }] },
      { ...version, items: copies(item, 101) },
    );
    changed.accepts(version);
    changed.rejects({ ...version, item }, { ...version, revision: -1 });
  });
});
