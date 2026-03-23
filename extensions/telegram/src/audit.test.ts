import { beforeEach, describe, expect, it, vi } from "vitest";

type AuditModule = typeof import("./audit.js");

let collectTelegramUnmentionedGroupIds: AuditModule["collectTelegramUnmentionedGroupIds"];
let auditTelegramGroupMembership: AuditModule["auditTelegramGroupMembership"];
const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    Agent:
      actual.Agent ??
      class Agent {
        close() {}
        destroy() {}
      },
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

async function auditSingleGroup() {
  return auditTelegramGroupMembership({
    token: "t",
    botId: 123,
    groupIds: ["-1001"],
    timeoutMs: 5000,
  });
}

describe("telegram audit", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ collectTelegramUnmentionedGroupIds, auditTelegramGroupMembership } =
      await import("./audit.js"));
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
});
