// Slack tests cover send.upload plugin behavior.
import type { WebClient } from "@slack/web-api";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./blocks.test-helpers.js";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
} from "./sent-thread-cache.js";

// --- Module mocks (must precede dynamic import) ---
const loadOutboundMediaFromUrlMock = vi.hoisted(() =>
  vi.fn(async (_mediaUrl: string, _options?: unknown) => ({
    buffer: Buffer.from("fake-image"),
    contentType: "image/png",
    kind: "image",
    fileName: "screenshot.png",
  })),
);
const GUARDED_FETCH_TEST_TIMEOUT_MS = 250;
const buildTimeoutAbortSignal = vi.hoisted(() =>
  vi.fn((params: { timeoutMs?: number }) => {
    if (!Number.isFinite(params.timeoutMs) || (params.timeoutMs ?? 0) <= 0) {
      throw new Error("Slack upload timeout requires a finite budget");
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      const error = new Error("request timed out");
      error.name = "TimeoutError";
      controller.abort(error);
    }, GUARDED_FETCH_TEST_TIMEOUT_MS);
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timeoutId),
      refresh: () => {},
    };
  }),
);
const fetchWithSsrFGuard = vi.fn(
  async (params: { url: string; init?: RequestInit; signal?: AbortSignal; timeoutMs?: number }) => {
    const signal =
      params.signal ??
      (Number.isFinite(params.timeoutMs) && (params.timeoutMs ?? 0) > 0
        ? AbortSignal.timeout(GUARDED_FETCH_TEST_TIMEOUT_MS)
        : undefined);
    if (!signal) {
      throw new Error("guarded Slack upload fetch requires a finite timeout signal");
    }
    return {
      response: await fetch(params.url, {
        ...params.init,
        signal,
      }),
      finalUrl: params.url,
      release: async () => {},
    } as const;
  },
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) =>
    fetchWithSsrFGuard(
      ...(args as [
        params: {
          url: string;
          init?: RequestInit;
          signal?: AbortSignal;
          timeoutMs?: number;
        },
      ]),
    ),
}));

vi.mock("openclaw/plugin-sdk/extension-shared", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/extension-shared")>(
    "openclaw/plugin-sdk/extension-shared",
  );
  return {
    ...actual,
    buildTimeoutAbortSignal: (...args: unknown[]) =>
      buildTimeoutAbortSignal(...(args as [params: { timeoutMs?: number }])),
  };
});

vi.mock("openclaw/plugin-sdk/fetch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/fetch-runtime")>(
    "openclaw/plugin-sdk/fetch-runtime",
  );
  return {
    ...actual,
    withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
      ...params,
      mode: "trusted_env_proxy",
    }),
  };
});

vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  const mockedLoadOutboundMediaFromUrl =
    loadOutboundMediaFromUrlMock as unknown as typeof actual.loadOutboundMediaFromUrl;
  return {
    ...actual,
    loadOutboundMediaFromUrl: (...args: Parameters<typeof actual.loadOutboundMediaFromUrl>) =>
      mockedLoadOutboundMediaFromUrl(...args),
  };
});

const { sendMessageSlack, clearSlackDmChannelCache } = await import("./send.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

type UploadTestClient = WebClient & {
  conversations: { open: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>> };
  chat: { postMessage: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>> };
  files: {
    getUploadURLExternal: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
    completeUploadExternal: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
  };
};

type MockCalls = {
  mock: { calls: unknown[][] };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const isObjectRecord = typeof value === "object" && value !== null && !Array.isArray(value);
  expect(isObjectRecord, `${label} should be an object`).toBe(true);
  if (!isObjectRecord) {
    throw new Error(`${label} should be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  const values = Array.isArray(value) ? value : null;
  expect(values, `${label} should be an array`).not.toBeNull();
  if (!values) {
    throw new Error(`${label} should be an array`);
  }
  return values;
}

function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  expect(record).toMatchObject(expected);
}

function expectCallFirstArg(
  mock: MockCalls,
  callNumber: number,
  expected: Record<string, unknown>,
  label = "mock first argument",
): Record<string, unknown> {
  expect(mock.mock.calls.length).toBeGreaterThanOrEqual(callNumber);
  const [firstArg] = mock.mock.calls[callNumber - 1] ?? [];
  const record = requireRecord(firstArg, label);
  expectFields(record, expected);
  return record;
}

function expectOnlyCallFirstArg(
  mock: MockCalls,
  expected: Record<string, unknown>,
  label?: string,
): Record<string, unknown> {
  expect(mock.mock.calls).toHaveLength(1);
  return expectCallFirstArg(mock, 1, expected, label);
}

function expectCompletedUpload(params: {
  client: UploadTestClient;
  expected: Record<string, unknown>;
  file?: Record<string, unknown>;
}) {
  const payload = expectOnlyCallFirstArg(
    params.client.files.completeUploadExternal,
    params.expected,
    "complete upload payload",
  );
  if (params.file) {
    const [file] = requireArray(payload.files, "complete upload files");
    expectFields(requireRecord(file, "complete upload file"), params.file);
  }
  return payload;
}

function createUploadTestClient(): UploadTestClient {
  return {
    conversations: {
      open: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
        channel: { id: "D99RESOLVED" },
      })),
    },
    chat: {
      postMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
        ts: "171234.567",
      })),
    },
    files: {
      getUploadURLExternal: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
        ok: true,
        upload_url: "https://uploads.slack.test/upload",
        file_id: "F001",
      })),
      completeUploadExternal: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
        ok: true,
      })),
    },
  } as unknown as UploadTestClient;
}

describe("sendMessageSlack file upload with user IDs", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    fetchWithSsrFGuard.mockClear();
    buildTimeoutAbortSignal.mockClear();
    loadOutboundMediaFromUrlMock.mockClear();
    clearSlackDmChannelCache();
    clearSlackThreadParticipationCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves bare user ID to DM channel before completing upload", async () => {
    const client = createUploadTestClient();

    // Bare user ID — parseSlackTarget classifies this as kind="channel"
    await sendMessageSlack("U2ZH3MFSR", "screenshot", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/screenshot.png",
    });

    // Should call conversations.open to resolve user ID → DM channel
    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U2ZH3MFSR",
    });

    expectCompletedUpload({
      client,
      expected: { channel_id: "D99RESOLVED" },
      file: { id: "F001", title: "screenshot.png" },
    });
  });

  it("resolves prefixed user ID to DM channel before completing upload", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "image", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/photo.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "UABC123",
    });
    expectCompletedUpload({ client, expected: { channel_id: "D99RESOLVED" } });
  });

  it("posts text-only user-target DMs directly without conversations.open", async () => {
    const client = createUploadTestClient();
    client.conversations.open.mockRejectedValueOnce(new Error("missing_scope"));

    await sendMessageSlack("user:UABC123", "first", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });
    await sendMessageSlack("user:UABC123", "second", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expectCallFirstArg(client.chat.postMessage, 2, {
      channel: "UABC123",
      text: "second",
    });
  });

  it("serializes concurrent sends to the same Slack target", async () => {
    const client = createUploadTestClient();
    let resolveFirst: (() => void) | undefined;
    client.chat.postMessage.mockImplementation(async (payload: unknown) => {
      const text =
        typeof payload === "object" && payload !== null && "text" in payload
          ? payload.text
          : undefined;
      if (text === "first") {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return { ts: "1.000" };
      }
      return { ts: "2.000" };
    });

    const first = sendMessageSlack("channel:C123CHAN", "first", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });
    await vi.waitFor(() => expect(client.chat.postMessage).toHaveBeenCalledTimes(1));

    const second = sendMessageSlack("channel:C123CHAN", "second", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });
    await Promise.resolve();

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    if (!resolveFirst) {
      throw new Error("Expected first Slack send release callback to be initialized");
    }
    resolveFirst();

    const firstResult = await first;
    expectFields(requireRecord(firstResult, "first send result"), {
      channelId: "C123CHAN",
      messageId: "1.000",
    });
    expectFields(requireRecord(firstResult.receipt, "first receipt"), {
      primaryPlatformMessageId: "1.000",
      platformMessageIds: ["1.000"],
    });
    const secondResult = await second;
    expectFields(requireRecord(secondResult, "second send result"), {
      channelId: "C123CHAN",
      messageId: "2.000",
    });
    expectFields(requireRecord(secondResult.receipt, "second receipt"), {
      primaryPlatformMessageId: "2.000",
      platformMessageIds: ["2.000"],
    });
    expectCallFirstArg(client.chat.postMessage, 2, { text: "second" });
  });

  it("scopes DM channel resolution cache by token identity", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "first", {
      token: "xoxb-test-a",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/first.png",
    });
    await sendMessageSlack("user:UABC123", "second", {
      token: "xoxb-test-b",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/second.png",
    });

    expect(client.conversations.open).toHaveBeenCalledTimes(2);
  });

  it("sends file directly to channel without conversations.open", async () => {
    const client = createUploadTestClient();

    const result = await sendMessageSlack("channel:C123CHAN", "chart", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/chart.png",
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expectCompletedUpload({ client, expected: { channel_id: "C123CHAN" } });
    expectFields(requireRecord(result.receipt, "receipt"), {
      primaryPlatformMessageId: "F001",
      platformMessageIds: ["F001"],
    });
    const [part] = requireArray(result.receipt.parts, "receipt parts");
    const partRecord = requireRecord(part, "receipt part");
    expectFields(partRecord, {
      platformMessageId: "F001",
      kind: "media",
    });
    expectFields(requireRecord(partRecord.raw, "receipt raw"), {
      channel: "slack",
      channelId: "C123CHAN",
    });
  });

  it("resolves mention-style user ID before file upload", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("<@U777TEST>", "report", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/report.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U777TEST",
    });
    expectCompletedUpload({ client, expected: { channel_id: "D99RESOLVED" } });
  });

  it("uploads bytes to the presigned URL and completes with thread+caption", async () => {
    const client = createUploadTestClient();

    const result = await sendMessageSlack("channel:C123CHAN", "caption", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/threaded.png",
      threadTs: "171.222",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "screenshot.png",
      length: Buffer.from("fake-image").length,
    });
    const fetchCalls = (globalThis.fetch as unknown as MockCalls).mock.calls;
    expect(fetchCalls).toHaveLength(1);
    const [fetchUrl, fetchInit] = fetchCalls[0] ?? [];
    expect(fetchUrl).toBe("https://uploads.slack.test/upload");
    expectFields(requireRecord(fetchInit, "fetch init"), { method: "POST" });
    expectOnlyCallFirstArg(buildTimeoutAbortSignal, {
      timeoutMs: 120_000,
      operation: "slack-upload-file",
      url: "https://uploads.slack.test",
    });
    expectOnlyCallFirstArg(fetchWithSsrFGuard, {
      url: "https://uploads.slack.test/upload",
      mode: "trusted_env_proxy",
      signal: expect.any(AbortSignal),
      auditContext: "slack-upload-file",
    });
    expectCompletedUpload({
      client,
      expected: {
        channel_id: "C123CHAN",
        initial_comment: "caption",
        thread_ts: "171.222",
      },
    });
    expect(hasSlackThreadParticipation("default", "C123CHAN", "171.222")).toBe(true);
    expect(result.receipt.threadId).toBe("171.222");
  });

  it("keeps the presigned upload capability out of timeout logging", async () => {
    const client = createUploadTestClient();
    client.files.getUploadURLExternal.mockResolvedValueOnce({
      ok: true,
      upload_url: "https://uploads.slack.test/upload/v1/secret-capability",
      file_id: "F001",
    });

    await sendMessageSlack("channel:C123CHAN", "caption", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/secret.png",
    });

    expectOnlyCallFirstArg(buildTimeoutAbortSignal, {
      timeoutMs: 120_000,
      operation: "slack-upload-file",
      url: "https://uploads.slack.test",
    });
    expectOnlyCallFirstArg(fetchWithSsrFGuard, {
      url: "https://uploads.slack.test/upload/v1/secret-capability",
    });
  });

  it("times out a hanging presigned URL upload", async () => {
    const client = createUploadTestClient();
    const closedResponses = vi.fn();

    await withServer(
      (req, res) => {
        req.resume();
        const route = `${req.method ?? "GET"} ${req.url ?? "/"}`;
        res.on("close", () => closedResponses(route));
        if (route === "POST /upload") {
          return;
        }
        res.statusCode = 500;
        res.end(`unexpected ${route}`);
      },
      async (baseUrl) => {
        globalThis.fetch = originalFetch;
        client.files.getUploadURLExternal.mockResolvedValueOnce({
          ok: true,
          upload_url: `${baseUrl}/upload`,
          file_id: "F001",
        });

        await expect(
          sendMessageSlack("channel:C123CHAN", "caption", {
            token: "xoxb-test",
            cfg: SLACK_TEST_CFG,
            client,
            mediaUrl: "/tmp/hanging.png",
          }),
        ).rejects.toThrow(/timed out|abort/i);

        await vi.waitFor(() => expect(closedResponses).toHaveBeenCalledWith("POST /upload"));
        expectOnlyCallFirstArg(buildTimeoutAbortSignal, {
          timeoutMs: 120_000,
          operation: "slack-upload-file",
          url: baseUrl,
        });
        expectOnlyCallFirstArg(fetchWithSsrFGuard, { signal: expect.any(AbortSignal) });
        expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
      },
    );
  });

  it("uses explicit upload filename and title overrides when provided", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/threaded.png",
      uploadFileName: "custom-name.bin",
      uploadTitle: "Custom Title",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "custom-name.bin",
      length: Buffer.from("fake-image").length,
    });
    expectCompletedUpload({
      client,
      expected: {},
      file: { id: "F001", title: "Custom Title" },
    });
  });

  it("uses uploadFileName as the title fallback when uploadTitle is omitted", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/threaded.png",
      uploadFileName: "custom-name.bin",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "custom-name.bin",
      length: Buffer.from("fake-image").length,
    });
    expectCompletedUpload({
      client,
      expected: {},
      file: { id: "F001", title: "custom-name.bin" },
    });
  });
});
