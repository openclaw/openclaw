import { createServer, type Server } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { releaseAccountThrottler } from "./account-throttler.js";
import { telegramPlugin } from "./channel.js";

const DEFAULT_TOKEN = "111111:telegram-membership-default-fixture";
const WORK_TOKEN = "222222:telegram-membership-work-fixture";
const MEMBER_ID = "7654321";

type FixtureMember = { status: string; is_member?: boolean };
type RecordedRequest = { botId: number; userId: number; chatId: string; method: string };

describe("Telegram directory group membership", () => {
  let server: Server;
  let apiRoot: string;
  let botStatus: string;
  let memberStatus: FixtureMember;
  let rejectMemberLookup: boolean;
  let requests: RecordedRequest[];
  let holdMemberLookup: boolean;
  let wrongUserIdFor: "bot" | "member" | undefined;
  let memberLookupStarted = createDeferred<void>();
  let memberResponseClosed = createDeferred<void>();

  beforeAll(async () => {
    for (const name of "HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy OPENCLAW_PROXY_URL OPENCLAW_DEBUG_PROXY_ENABLED OPENCLAW_DEBUG_PROXY_URL".split(
      " ",
    )) {
      vi.stubEnv(name, "");
    }
    server = createServer((request, response) => {
      const path = request.url ?? "";
      const endpoint = /\/bot(\d+):[^/]+\/([^/?]+)/u.exec(path);
      const botId = Number(endpoint?.[1]);
      const method = endpoint?.[2] ?? "unknown";
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          chat_id: string | number;
          user_id: number;
        };
        const userId = payload.user_id;
        requests.push({ botId, userId, chatId: String(payload.chat_id), method });
        if (holdMemberLookup && userId !== botId) {
          memberLookupStarted.resolve();
          response.on("close", () => memberResponseClosed.resolve());
          return;
        }
        if (rejectMemberLookup && userId !== botId) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ ok: false, error_code: 403, description: "fixture denied" }),
          );
          return;
        }
        const member = userId === botId ? { status: botStatus } : memberStatus;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            result: {
              ...member,
              user: {
                id: wrongUserIdFor === (userId === botId ? "bot" : "member") ? userId + 1 : userId,
                is_bot: userId === botId,
                first_name: "Fixture",
              },
            },
          }),
        );
      });
    });
    apiRoot = "http://127.0.0.1:" + (await listenOnLoopback(server));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    botStatus = "administrator";
    memberStatus = { status: "member" };
    rejectMemberLookup = false;
    holdMemberLookup = false;
    wrongUserIdFor = undefined;
    memberLookupStarted = createDeferred<void>();
    memberResponseClosed = createDeferred<void>();
    requests = [];
  });

  afterEach(async () => {
    await Promise.all([
      releaseAccountThrottler(DEFAULT_TOKEN),
      releaseAccountThrottler(WORK_TOKEN),
    ]);
  });

  function config(): OpenClawConfig {
    return {
      channels: {
        telegram: {
          botToken: DEFAULT_TOKEN,
          apiRoot,
          accounts: { work: { botToken: WORK_TOKEN, apiRoot } },
        },
      },
    } as unknown as OpenClawConfig;
  }

  async function check(params: {
    groupId: string;
    memberId?: string;
    accountId?: string;
    signal?: AbortSignal;
  }): Promise<boolean | null> {
    const adapter = telegramPlugin.directory?.isGroupMember;
    if (!adapter) {
      throw new Error("Telegram directory membership adapter is unavailable");
    }
    return await adapter({
      cfg: config(),
      groupId: params.groupId,
      memberId: params.memberId ?? MEMBER_ID,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
  }

  it.each(["-42", "-10042"])(
    "checks exact signed group ID %s with the default bot",
    async (groupId) => {
      await expect(check({ groupId })).resolves.toBe(true);
      expect(requests).toEqual([
        { botId: 111111, userId: 111111, chatId: groupId, method: "getChatMember" },
        { botId: 111111, userId: Number(MEMBER_ID), chatId: groupId, method: "getChatMember" },
      ]);
    },
  );

  it("uses the explicitly scoped bot account", async () => {
    await expect(check({ groupId: "-10077", accountId: "work" })).resolves.toBe(true);
    expect(requests.map((request) => request.botId)).toEqual([222222, 222222]);
  });

  it.each([
    ["creator", { status: "creator" }, true],
    ["administrator", { status: "administrator" }, true],
    ["member", { status: "member" }, true],
    ["restricted member", { status: "restricted", is_member: true }, true],
    ["restricted nonmember", { status: "restricted", is_member: false }, false],
    ["left", { status: "left" }, false],
    ["kicked", { status: "kicked" }, false],
    ["unknown status", { status: "unknown" }, null],
  ] as const)("maps %s membership evidence", async (_label, status, expected) => {
    memberStatus = status;
    await expect(check({ groupId: "-42" })).resolves.toBe(expected);
  });

  it("uses confirmed user membership when the bot is an ordinary group member", async () => {
    botStatus = "member";
    await expect(check({ groupId: "-42" })).resolves.toBe(true);
    memberStatus = { status: "left" };
    await expect(check({ groupId: "-42" })).resolves.toBe(false);
    expect(requests).toHaveLength(4);
  });

  it("fails closed when bot membership or the user lookup is unavailable", async () => {
    botStatus = "left";
    await expect(check({ groupId: "-42" })).resolves.toBeNull();
    expect(requests).toHaveLength(1);

    requests = [];
    botStatus = "member";
    rejectMemberLookup = true;
    await expect(check({ groupId: "-42" })).resolves.toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("does not fall back to the default bot for an unknown account", async () => {
    await expect(check({ groupId: "-42", accountId: "deleted" })).resolves.toBeNull();
    expect(requests).toHaveLength(0);
  });

  it.each(["bot", "member"] as const)(
    "rejects a %s getChatMember response whose user ID differs from the query",
    async (identity) => {
      wrongUserIdFor = identity;
      await expect(check({ groupId: "-42" })).resolves.toBeNull();
      expect(requests).toHaveLength(identity === "bot" ? 1 : 2);
    },
  );

  it("aborts the whole check at its deadline and closes the pending Bot API request", async () => {
    holdMemberLookup = true;
    const pending = check({ groupId: "-42" });
    await memberLookupStarted.promise;
    await expect(pending).resolves.toBeNull();
    await expect(memberResponseClosed.promise).resolves.toBeUndefined();
  });

  it("propagates the caller signal to the pending Bot API request", async () => {
    holdMemberLookup = true;
    const controller = new AbortController();
    const pending = check({ groupId: "-42", signal: controller.signal });
    await memberLookupStarted.promise;
    controller.abort();
    await expect(pending).resolves.toBeNull();
    await expect(memberResponseClosed.promise).resolves.toBeUndefined();
  });

  it("rejects topic targets and nonnumeric identities without a Bot API request", async () => {
    await expect(check({ groupId: "-10042:topic:17" })).resolves.toBeNull();
    await expect(check({ groupId: "-42", memberId: "denis" })).resolves.toBeNull();
    await expect(check({ groupId: "-42", memberId: "0" })).resolves.toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("observes membership changes on the next check instead of retaining an authorization cache", async () => {
    await expect(check({ groupId: "-42" })).resolves.toBe(true);
    memberStatus = { status: "left" };
    await expect(check({ groupId: "-42" })).resolves.toBe(false);
    expect(requests).toHaveLength(4);
  });
});
