import { WebClient } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { resolveSlackListenerEventScope } from "./monitor/event-scope.js";
import { sendMessageSlack } from "./send.js";
import { clearSlackThreadParticipationCache } from "./sent-thread-cache.js";

vi.mock("openclaw/plugin-sdk/outbound-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/outbound-media")>()),
  loadOutboundMediaFromUrl: async () => ({
    buffer: Buffer.from("fixture"),
    contentType: "text/plain",
    fileName: "fixture.txt",
  }),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: async () => ({ response: new Response("ok"), release: async () => {} }),
}));

const root = "171234.100";
const botToken = "xoxb-parent-writer";
const userToken = "xoxp-parent-reader";
const cfg = { channels: { slack: { botToken, userToken } } };
type Request = {
  token: string | undefined;
  method: string;
  args: URLSearchParams;
  signal: AbortSignal | null | undefined;
};
let requests: Request[];
let respond: (request: Request) => object | Promise<object>;
const transport: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const request = {
    token: new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, ""),
    method: new URL(url).pathname.split("/").at(-1)!,
    args: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    signal: init?.signal,
  };
  requests.push(request);
  return Response.json(await respond(request));
};
function liveResponse({ method }: Request) {
  switch (method) {
    case "conversations.history":
      return { ok: true, messages: [{ ts: root }] };
    case "conversations.replies":
      return { ok: false, error: "thread_not_found" };
    case "files.getUploadURLExternal":
      return { ok: true, file_id: "F123", upload_url: "https://files.slack.com/upload/fixture" };
    default:
      return { ok: true, ts: "171235.1", channel: "C123" };
  }
}
const reads = () => requests.filter(({ method }) => method.startsWith("conversations."));
const publications = () =>
  requests.filter(
    ({ method }) => method === "chat.postMessage" || method === "files.completeUploadExternal",
  );

beforeEach(() => {
  requests = [];
  respond = liveResponse;
  for (const key of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "SLACK_API_URL",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubGlobal("fetch", transport);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearSlackThreadParticipationCache();
});

describe("Slack parent verification through the SDK transport", () => {
  it.each(["text", "file"])("preserves the monitor's configured reader for %s", async (kind) => {
    respond = (request) =>
      request.method === "conversations.history" && request.token === botToken
        ? { ok: false, error: "missing_scope" }
        : liveResponse(request);
    await sendMessageSlack("C123", "reply", {
      cfg,
      token: botToken,
      threadTs: root,
      ...(kind === "file" ? { mediaUrl: "https://example.com/fixture.txt" } : {}),
    });
    expect(reads()).toHaveLength(1);
    expect(reads()[0]?.token).toBe(userToken);
    expect(publications()).toHaveLength(1);
    expect(publications()[0]?.token).toBe(botToken);
    expect(publications()[0]?.args.get("thread_ts")).toBe(root);
  });

  it.each(["text", "file"])(
    "stops missing-parent %s without duplicate same-token reads",
    async (kind) => {
      respond = (request) =>
        request.method === "conversations.history"
          ? { ok: true, messages: [] }
          : liveResponse(request);
      await expect(
        sendMessageSlack("C123", "reply", {
          cfg: { channels: { slack: { botToken, userToken: botToken } } },
          threadTs: root,
          ...(kind === "file" ? { mediaUrl: "https://example.com/fixture.txt" } : {}),
        }),
      ).rejects.toMatchObject({ name: "PlatformMessageNotDispatchedError", retryable: false });
      expect(reads().map(({ method }) => method)).toEqual([
        "conversations.history",
        "conversations.replies",
      ]);
      expect(reads().every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
      expect(publications()).toEqual([]);
    },
  );

  it("keeps unrelated explicit credentials isolated from the account reader", async () => {
    await sendMessageSlack("C123", "reply", { cfg, token: "xoxb-custom", threadTs: root });
    expect(reads()).toHaveLength(1);
    expect(requests.every(({ token }) => token === "xoxb-custom")).toBe(true);
    expect(reads()[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([false, true])(
    "aborts a stalled parent read and releases the queue (writer fallback: %s)",
    async (fallback) => {
      const started = createDeferred<void>();
      const controllers: AbortController[] = [];
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        expect(ms).toBe(30_000);
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      });
      let stall = true;
      respond = async (request) => {
        if (request.method === "conversations.history") {
          if (fallback && request.token === userToken) {
            return { ok: false, error: "channel_not_found" };
          }
          if (stall) {
            stall = false;
            started.resolve();
            const signal = request.signal;
            if (!signal) {
              throw new Error("parent read has no deadline");
            }
            await new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  const reason: unknown = signal.reason;
                  reject(reason instanceof Error ? reason : new Error("parent read aborted"));
                },
                { once: true },
              );
            });
          }
        }
        return liveResponse(request);
      };
      const options = {
        cfg: fallback ? cfg : { channels: { slack: { botToken } } },
        threadTs: root,
      };
      const first = sendMessageSlack("C123", "blocked", options).catch((error: unknown) => error);
      await started.promise;
      const next = sendMessageSlack("C123", "next", options);
      controllers.at(-1)?.abort(new DOMException("deadline", "TimeoutError"));
      await expect(first).resolves.toMatchObject({ name: "PlatformMessageNotDispatchedError" });
      await expect(next).resolves.toMatchObject({ messageId: "171235.1" });
      expect(reads().every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
      expect(publications().map(({ args }) => args.get("text"))).toEqual(["next"]);
      expect(publications()[0]?.signal).toBeUndefined();
    },
  );

  it.each([true, false])(
    "preserves Enterprise transport/team with one bounded reader (live: %s)",
    async (live) => {
      respond = (request) =>
        request.method === "conversations.history" && !live
          ? { ok: true, messages: [] }
          : liveResponse(request);
      const clientOptions = { fetch: transport, slackApiUrl: "https://enterprise.invalid/api/" };
      const scope = resolveSlackListenerEventScope({
        identity: { kind: "enterprise", apiAppId: "A123", enterpriseId: "E123" },
        body: {},
        context: { isEnterpriseInstall: true, enterpriseId: "E123", teamId: "T123" },
        client: new WebClient("xoxb-enterprise-parent", clientOptions),
        clientOptions,
      });
      expect(scope).toBeTruthy();
      vi.stubGlobal("fetch", () => {
        throw new Error("lost Enterprise transport");
      });
      const result = sendMessageSlack("C123", "reply", { cfg, eventScope: scope!, threadTs: root });
      if (live) {
        await expect(result).resolves.toMatchObject({ messageId: "171235.1" });
      } else {
        await expect(result).rejects.toMatchObject({ retryable: false });
      }
      expect(reads()).toHaveLength(live ? 1 : 2);
      expect(reads().every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
      expect(
        requests.every(
          ({ args, token }) => args.get("team_id") === "T123" && token === "xoxb-enterprise-parent",
        ),
      ).toBe(true);
      expect(publications()).toHaveLength(live ? 1 : 0);
    },
  );
  it.each([
    { enterprise: false, live: true },
    { enterprise: false, live: false },
    { enterprise: true, live: true },
    { enterprise: true, live: false },
  ])(
    "checks native approval parents (Enterprise: $enterprise, live: $live)",
    async ({ enterprise, live }) => {
      const token = enterprise ? "xoxb-enterprise-approval" : botToken;
      const clientOptions = {
        fetch: transport,
        slackApiUrl: "https://approval.invalid/api/",
        ...(enterprise ? { teamId: "T123" } : {}),
        timeout: 0,
        headers: { Authorization: `Bearer ${token}` },
      };
      const client = new WebClient(token, clientOptions);
      respond = (request) => {
        if (request.method === "conversations.info") {
          return { ok: true, channel: { id: "C123", context_team_id: "T123" } };
        }
        if (request.method === "conversations.history") {
          if (!enterprise && request.token === botToken) {
            return { ok: false, error: "missing_scope" };
          }
          return { ok: true, messages: live ? [{ ts: root }] : [] };
        }
        return liveResponse(request);
      };
      vi.stubGlobal("fetch", () => {
        throw new Error("lost approval transport");
      });
      const result = slackApprovalNativeRuntime.transport.deliverPending({
        cfg,
        accountId: "default",
        context: {
          app: { client, webClientOptions: clientOptions },
          config: {},
          ...(enterprise
            ? { enterprise: { enterpriseId: "E123" }, resolveClient: () => client }
            : {}),
        },
        request: {
          id: "approval-parent",
          request: { command: "echo hi" },
          createdAtMs: 0,
          expiresAtMs: 60000,
        },
        approvalKind: "exec",
        plannedTarget: {
          surface: "origin",
          reason: "preferred",
          target: { to: "channel:C123", threadId: root },
        },
        preparedTarget: {
          to: "channel:C123",
          threadTs: root,
          ...(enterprise ? { teamId: "T123" } : {}),
        },
        pendingPayload: {
          text: "Waiting",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Waiting" } }],
        },
        view: {
          approvalKind: "exec",
          phase: "pending",
          approvalId: "approval-parent",
          title: "Exec approval",
          commandText: "echo hi",
          metadata: [],
          actions: [],
          expiresAtMs: 60000,
        },
      });
      if (live) {
        await expect(result).resolves.toMatchObject({ channelId: "C123", messageTs: "171235.1" });
        expect(publications()[0]?.args.get("thread_ts")).toBe(root);
      } else {
        await expect(result).rejects.toMatchObject({ name: "PlatformMessageNotDispatchedError" });
      }
      const parentReads = reads().filter(({ method }) => method !== "conversations.info");
      expect(parentReads[0]?.token).toBe(enterprise ? token : userToken);
      expect(parentReads.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
      expect(publications()).toHaveLength(live ? 1 : 0);
      if (enterprise) {
        expect(parentReads).toHaveLength(live ? 1 : 2);
        expect(requests.every(({ args }) => args.get("team_id") === "T123")).toBe(true);
      }
    },
  );
});
