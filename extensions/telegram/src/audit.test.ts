import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let collectTelegramUnmentionedGroupIds: typeof import("./audit.js").collectTelegramUnmentionedGroupIds;
let auditTelegramGroupMembership: typeof import("./audit.js").auditTelegramGroupMembership;
const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: undiciFetch,
  };
});

function mockGetChatMemberStatus(status: string) {
  undiciFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: true, result: { status } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function auditSingleGroup(options?: { apiRoot?: string }) {
  return auditTelegramGroupMembership({
    token: "t",
    botId: 123,
    groupIds: ["-1001"],
    apiRoot: options?.apiRoot,
    timeoutMs: 5000,
  });
}

describe("telegram audit", () => {
  beforeAll(async () => {
    ({ collectTelegramUnmentionedGroupIds, auditTelegramGroupMembership } =
      await import("./audit.js"));
  });

  beforeEach(() => {
    undiciFetch.mockReset();
  });

  it("collects unmentioned numeric group ids and flags wildcard", async () => {
    const res = collectTelegramUnmentionedGroupIds({
      "*": { requireMention: false },
      "-1001": { requireMention: false },
      "@group": { requireMention: false },
      "-1002": { requireMention: true },
      "-1003": { requireMention: false, enabled: false },
    });
    expect(res.hasWildcardUnmentionedGroups).toBe(true);
    expect(res.groupIds).toEqual(["-1001"]);
    expect(res.unresolvedGroups).toBe(1);
  });

  it("audits membership via getChatMember", async () => {
    mockGetChatMemberStatus("member");
    const res = await auditSingleGroup();
    expect(res.ok).toBe(true);
    expect(res.groups[0]?.chatId).toBe("-1001");
    expect(res.groups[0]?.status).toBe("member");
  });

  it("reports bot not in group when status is left", async () => {
    mockGetChatMemberStatus("left");
    const res = await auditSingleGroup();
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.ok).toBe(false);
    expect(res.groups[0]?.status).toBe("left");
  });

  it("uses a custom Telegram Bot API root for membership checks", async () => {
    mockGetChatMemberStatus("member");
    await auditSingleGroup({ apiRoot: "http://127.0.0.1:8081/" });
    expect(undiciFetch.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8081/bott/getChatMember?chat_id=-1001&user_id=123",
    );
  });
});
