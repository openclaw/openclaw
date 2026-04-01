import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

type FetchCall = [unknown, RequestInit?];

function requestUrlFromCall(call: FetchCall | undefined): string {
  const value = call?.[0];
  if (value instanceof URL) {
    return value.toString();
  }
  return typeof value === "string" ? value : "";
}

function parseRequestBody<T>(body: unknown): T {
  if (typeof body === "string") {
    return JSON.parse(body) as T;
  }
  if (body && typeof body === "object") {
    return body as T;
  }
  return {} as T;
}

describe("Atlas-backed OpenClaw tools", () => {
  beforeEach(() => {
    process.env.OPENCLAW_ATLAS_WEB_BASE_URL = "https://atlas.example.test";
    process.env.OPENCLAW_ATLAS_A2A_TOKEN = "atlas-test-token";
  });

  afterEach(() => {
    delete process.env.OPENCLAW_ATLAS_WEB_BASE_URL;
    delete process.env.OPENCLAW_ATLAS_A2A_TOKEN;
    vi.unstubAllGlobals();
  });

  it("exposes atlas inspect and execution tools", () => {
    const names = createOpenClawTools().map((tool) => tool.name);
    expect(names).toContain("atlas_inspect");
    expect(names).toContain("atlas_execution");
  });

  it("atlas_inspect reads snapshot file content through Atlas API", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            repo: "homio/core",
            headSha: "abc123",
            path: "src/button.tsx",
            content: 'export const label = "Sign in";\n',
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_inspect");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_inspect tool");
    }

    const result = await tool.execute("call-atlas-inspect", {
      action: "file",
      repo: "homio/core",
      ref: "abc123",
      path: "src/button.tsx",
    });

    const details = result.details as {
      ok?: boolean;
      action?: string;
      result?: { content?: string; headSha?: string };
    };
    expect(details.ok).toBe(true);
    expect(details.action).toBe("file");
    expect(details.result?.headSha).toBe("abc123");
    expect(details.result?.content).toContain("Sign in");

    const call = fetchMock.mock.calls[0] as unknown as FetchCall;
    const [, init] = call;
    const requestUrl = requestUrlFromCall(call);
    expect(requestUrl).toContain("/api/runtime/inspect/file");
    expect(requestUrl).toContain("repo=homio%2Fcore");
    expect(requestUrl).toContain("path=src%2Fbutton.tsx");
    expect(init).toBeDefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer atlas-test-token");
  });

  it("atlas_execution submits execution briefs and surfaces 409 conflicts without throwing", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/runtime/work-threads/by-topic")) {
        return new Response(JSON.stringify({ workThread: { id: "wt-conflict" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === "POST" && href.includes("/api/a2a/tasks")) {
        return new Response(
          JSON.stringify({
            error: "a2a_active_topic_execution_exists",
            conflict: true,
            existingTaskId: "existing-task-1",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-submit", {
      action: "submit",
      taskId: "atlas-task-1",
      title: "Login button polish",
      repo: "homio/core",
      intent: "implement_feature",
      branch: "feature/login-button",
      envName: "ai02",
      sourceTransport: "telegram-topic",
      sourceChatId: "-100777",
      sourceThreadId: "4401",
      brief: "Improve the login button copy and color.",
      acceptanceCriteria: "Button says Войти and the visual contrast passes.",
      verifyPlan: "Add/update a focused UI test and run verify before preview.",
    });

    const details = result.details as {
      ok?: boolean;
      conflict?: boolean;
      result?: { existingTaskId?: string };
    };
    expect(details.ok).toBe(false);
    expect(details.conflict).toBe(true);
    expect(details.result?.existingTaskId).toBe("existing-task-1");

    const submitCall = fetchMock.mock.calls.find(
      ([requestUrl, requestInit]) =>
        String(requestUrl).includes("/api/a2a/tasks") && requestInit?.method === "POST",
    );
    expect(submitCall).toBeDefined();
    const [, init] = submitCall as unknown as FetchCall;
    expect(init).toBeDefined();
    const body = parseRequestBody<{
      executionSpec?: {
        taskId?: string;
        repo?: string;
        metadata?: Record<string, unknown>;
        target?: { env?: string; branch?: string };
      };
      source?: { transport?: string; chatId?: string; threadId?: string };
      metadata?: Record<string, unknown>;
    }>(init?.body);
    expect(body.executionSpec?.taskId).toBe("atlas-task-1");
    expect(body.executionSpec?.repo).toBe("homio/core");
    expect(body.executionSpec?.target?.env).toBe("ai02");
    expect(body.executionSpec?.target?.branch).toBe("feature/login-button");
    expect(body.executionSpec?.metadata?.brief).toBe("Improve the login button copy and color.");
    expect(body.source?.transport).toBe("telegram-topic");
    expect(body.source?.chatId).toBe("-100777");
    expect(body.source?.threadId).toBe("4401");
    expect(body.metadata?.verifyPlan).toBe(
      "Add/update a focused UI test and run verify before preview.",
    );
  });

  it("atlas_execution infers telegram-topic source from tool context", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/runtime/work-threads/by-topic")) {
        return new Response(JSON.stringify({ workThread: { id: "wt-ctx" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === "POST" && href.includes("/api/a2a/tasks")) {
        return new Response(JSON.stringify({ id: "atlas-task-ctx" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools({
      agentChannel: "telegram",
      agentTo: "telegram:group:-100777:topic:4401",
      agentThreadId: "4401",
    }).find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-submit-context", {
      action: "submit",
      taskId: "atlas-task-ctx",
      title: "Login button polish",
      repo: "homio/core",
      intent: "implement_feature",
      brief: "Improve the login button copy and color.",
    });

    const details = result.details as { ok?: boolean; result?: { id?: string } };
    expect(details.ok).toBe(true);
    expect(details.result?.id).toBe("atlas-task-ctx");

    const submitCall = fetchMock.mock.calls.find(
      ([requestUrl, requestInit]) =>
        String(requestUrl).includes("/api/a2a/tasks") && requestInit?.method === "POST",
    );
    expect(submitCall).toBeDefined();
    const [, init] = submitCall as unknown as FetchCall;
    expect(init).toBeDefined();
    const body = parseRequestBody<{
      source?: { transport?: string; chatId?: string; threadId?: string };
    }>(init?.body);
    expect(body.source?.transport).toBe("telegram-topic");
    expect(body.source?.chatId).toBe("-100777");
    expect(body.source?.threadId).toBe("4401");
  });

  it("atlas_execution infers telegram chat from split target + thread context", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/runtime/work-threads/by-topic")) {
        return new Response(JSON.stringify({ workThread: { id: "wt-split-ctx" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === "POST" && href.includes("/api/a2a/tasks")) {
        return new Response(JSON.stringify({ id: "atlas-task-split-ctx" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools({
      agentChannel: "telegram",
      agentTo: "telegram:-100777",
      agentThreadId: "4401",
    }).find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-submit-split-context", {
      action: "submit",
      taskId: "atlas-task-split-ctx",
      title: "Login button polish",
      repo: "homio/core",
      intent: "implement_feature",
      brief: "Improve the login button copy and color.",
    });

    const details = result.details as { ok?: boolean; result?: { id?: string } };
    expect(details.ok).toBe(true);
    expect(details.result?.id).toBe("atlas-task-split-ctx");

    const submitCall = fetchMock.mock.calls.find(
      ([requestUrl, requestInit]) =>
        String(requestUrl).includes("/api/a2a/tasks") && requestInit?.method === "POST",
    );
    expect(submitCall).toBeDefined();
    const [, init] = submitCall as unknown as FetchCall;
    expect(init).toBeDefined();
    const body = parseRequestBody<{
      source?: { transport?: string; chatId?: string; threadId?: string };
    }>(init?.body);
    expect(body.source?.transport).toBe("telegram-topic");
    expect(body.source?.chatId).toBe("-100777");
    expect(body.source?.threadId).toBe("4401");
  });

  it("atlas_execution defaults to openclaw transport when no source context exists", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "atlas-task-openclaw" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-submit-openclaw", {
      action: "submit",
      taskId: "atlas-task-openclaw",
      title: "Login button polish",
      repo: "homio/core",
      intent: "implement_feature",
      brief: "Improve the login button copy and color.",
    });

    const details = result.details as { ok?: boolean; result?: { id?: string } };
    expect(details.ok).toBe(true);
    expect(details.result?.id).toBe("atlas-task-openclaw");

    const submitCall = fetchMock.mock.calls.find(
      ([requestUrl, requestInit]) =>
        String(requestUrl).includes("/api/a2a/tasks") && requestInit?.method === "POST",
    );
    expect(submitCall).toBeDefined();
    const [, init] = submitCall as unknown as FetchCall;
    expect(init).toBeDefined();
    const body = parseRequestBody<{
      source?: { transport?: string; chatId?: string | null; threadId?: string | null };
    }>(init?.body);
    expect(body.source?.transport).toBe("openclaw");
    expect(body.source?.chatId ?? null).toBeNull();
    expect(body.source?.threadId ?? null).toBeNull();
  });

  it("atlas_execution infers bitrix transport when task context is bitrix-linked", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/runtime/work-threads?")) {
        return new Response(JSON.stringify({ workThreads: [{ id: "wt-bitrix" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === "POST" && href.includes("/api/a2a/tasks")) {
        return new Response(JSON.stringify({ id: "atlas-task-bitrix" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools({
      agentChannel: "bitrix",
    }).find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-submit-bitrix", {
      action: "submit",
      taskId: "atlas-task-bitrix",
      title: "Bitrix-linked polish",
      repo: "homio/core",
      intent: "implement_feature",
      brief: "Improve the login button copy and color.",
      bitrixTaskId: "bitrix-12345",
    });

    const details = result.details as { ok?: boolean; result?: { id?: string } };
    expect(details.ok).toBe(true);
    expect(details.result?.id).toBe("atlas-task-bitrix");

    const submitCall = fetchMock.mock.calls.find(
      ([requestUrl, requestInit]) =>
        String(requestUrl).includes("/api/a2a/tasks") && requestInit?.method === "POST",
    );
    expect(submitCall).toBeDefined();
    const [, init] = submitCall as unknown as FetchCall;
    expect(init).toBeDefined();
    const body = parseRequestBody<{
      source?: { transport?: string };
    }>(init?.body);
    expect(body.source?.transport).toBe("bitrix");
  });

  it("atlas_execution infers bitrix chat id from bitrix target context", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "atlas-task-bitrix-chat" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ workThreads: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools({
      agentChannel: "bitrix",
      agentTo: "bitrix:chat-441",
    }).find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-submit-bitrix-chat", {
      action: "submit",
      taskId: "atlas-task-bitrix-chat",
      title: "Bitrix chat inference",
      repo: "homio/core",
      intent: "implement_feature",
      brief: "Use existing bitrix context.",
      bitrixTaskId: "bitrix-441",
    });

    const details = result.details as { ok?: boolean; result?: { id?: string } };
    expect(details.ok).toBe(true);
    expect(details.result?.id).toBe("atlas-task-bitrix-chat");

    const [, init] = fetchMock.mock.calls.at(-1) as unknown as FetchCall;
    expect(init).toBeDefined();
    const body = parseRequestBody<{
      source?: { transport?: string; chatId?: string | null };
    }>(init?.body);
    expect(body.source?.transport).toBe("bitrix");
    expect(body.source?.chatId).toBe("chat-441");
  });

  it("atlas_execution keeps atlasTaskId distinct from bitrixTaskId when no explicit atlas task exists", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/runtime/work-threads?")) {
        return new Response(JSON.stringify({ workThreads: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href.includes("/api/runtime/work-threads/ensure")) {
        return new Response(JSON.stringify({ workThread: { id: "wt-bitrix-separate" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === "POST" && href.includes("/api/a2a/tasks")) {
        return new Response(JSON.stringify({ id: "a2a-task-bitrix-separate" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools({
      agentChannel: "bitrix",
      agentTo: "bitrix:chat-777",
    }).find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-submit-bitrix-separate", {
      action: "submit",
      taskId: "a2a-task-bitrix-separate",
      title: "Bitrix linked intake",
      repo: "homio/core",
      intent: "implement_feature",
      branch: "feature/bitrix-separate-id",
      brief: "Keep Atlas ownership separate from linked Bitrix work.",
      bitrixTaskId: "bitrix-777",
    });

    const details = result.details as { ok?: boolean; result?: { id?: string } };
    expect(details.ok).toBe(true);
    expect(details.result?.id).toBe("a2a-task-bitrix-separate");

    const ensureBody = parseRequestBody<{
      atlasTaskId?: string | null;
      bitrixTaskId?: string | null;
    }>(fetchMock.mock.calls[1]?.[1]?.body);
    expect(ensureBody.atlasTaskId).toBe("a2a-task-bitrix-separate");
    expect(ensureBody.bitrixTaskId).toBe("bitrix-777");

    const submitCall = fetchMock.mock.calls.find(
      ([requestUrl, requestInit]) =>
        String(requestUrl).includes("/api/a2a/tasks") && requestInit?.method === "POST",
    );
    expect(submitCall).toBeDefined();
    const [, submitInit] = submitCall as unknown as FetchCall;
    expect(submitInit).toBeDefined();
    const submitBody = parseRequestBody<{
      executionSpec?: { taskId?: string; target?: { taskId?: string | null } };
      metadata?: Record<string, unknown>;
    }>(submitInit?.body);
    expect(submitBody.executionSpec?.taskId).toBe("a2a-task-bitrix-separate");
    expect(submitBody.executionSpec?.target?.taskId).toBe("a2a-task-bitrix-separate");
    expect(submitBody.metadata?.bitrixTaskId).toBe("bitrix-777");
  });

  it("atlas_execution ensures a bitrix work thread when fallback intake has no topic yet", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/runtime/work-threads?")) {
        return new Response(JSON.stringify({ workThreads: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href.includes("/api/runtime/work-threads/ensure")) {
        return new Response(JSON.stringify({ workThread: { id: "wt-bitrix-fallback" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === "POST" && href.includes("/api/a2a/tasks")) {
        return new Response(JSON.stringify({ id: "atlas-task-bitrix-fallback" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools({
      agentChannel: "bitrix",
      agentTo: "bitrix:chat-991",
    }).find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-submit-bitrix-fallback", {
      action: "submit",
      taskId: "a2a-task-bitrix-fallback",
      atlasTaskId: "atlas-task-bitrix-fallback",
      title: "Bitrix fallback intake",
      repo: "homio/core",
      intent: "implement_feature",
      branch: "feature/bitrix-fallback",
      envName: "ai03",
      brief: "Create a canonical work thread before any telegram topic exists.",
      bitrixTaskId: "bitrix-991",
    });

    const details = result.details as { ok?: boolean; result?: { id?: string } };
    expect(details.ok).toBe(true);
    expect(details.result?.id).toBe("atlas-task-bitrix-fallback");

    expect(requestUrlFromCall(fetchMock.mock.calls[0] as unknown as FetchCall)).toContain(
      "/api/runtime/work-threads?",
    );
    expect(requestUrlFromCall(fetchMock.mock.calls[1] as unknown as FetchCall)).toContain(
      "/api/runtime/work-threads/ensure",
    );

    const ensureBody = parseRequestBody<{
      ownerTransport?: string;
      atlasTaskId?: string | null;
      bitrixTaskId?: string | null;
      bitrixChatId?: string | null;
    }>(fetchMock.mock.calls[1]?.[1]?.body);
    expect(ensureBody.ownerTransport).toBe("bitrix");
    expect(ensureBody.atlasTaskId).toBe("atlas-task-bitrix-fallback");
    expect(ensureBody.bitrixTaskId).toBe("bitrix-991");
    expect(ensureBody.bitrixChatId).toBe("chat-991");

    const submitCall = fetchMock.mock.calls.find(
      ([requestUrl, requestInit]) =>
        String(requestUrl).includes("/api/a2a/tasks") && requestInit?.method === "POST",
    );
    expect(submitCall).toBeDefined();
    const [, submitInit] = submitCall as unknown as FetchCall;
    expect(submitInit).toBeDefined();
    const submitBody = parseRequestBody<{
      metadata?: Record<string, unknown>;
      executionSpec?: { metadata?: Record<string, unknown> };
    }>(submitInit?.body);
    expect(submitBody.metadata?.workThreadId).toBe("wt-bitrix-fallback");
    expect(submitBody.executionSpec?.metadata?.workThreadId).toBe("wt-bitrix-fallback");
  });

  it("atlas_execution does not infer bitrix from generic targetTaskId alone", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "atlas-task-generic-target" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-submit-generic-target", {
      action: "submit",
      taskId: "atlas-task-generic-target",
      title: "Generic linked work item",
      repo: "homio/core",
      intent: "implement_feature",
      brief: "Improve the login button copy and color.",
      targetTaskId: "external-work-item-77",
    });

    const details = result.details as { ok?: boolean; result?: { id?: string } };
    expect(details.ok).toBe(true);
    expect(details.result?.id).toBe("atlas-task-generic-target");

    const [, init] = fetchMock.mock.calls[0] as unknown as FetchCall;
    expect(init).toBeDefined();
    const body = parseRequestBody<{
      atlasTaskId?: string | null;
      source?: { transport?: string };
      executionSpec?: {
        taskId?: string | null;
        target?: { taskId?: string | null };
        metadata?: Record<string, unknown>;
      };
      metadata?: Record<string, unknown>;
    }>(init?.body);
    expect(body.atlasTaskId).toBe("atlas-task-generic-target");
    expect(body.executionSpec?.taskId).toBe("atlas-task-generic-target");
    expect(body.executionSpec?.target?.taskId).toBe("atlas-task-generic-target");
    expect(body.executionSpec?.metadata?.linkedTargetTaskId).toBe("external-work-item-77");
    expect(body.metadata?.linkedTargetTaskId).toBe("external-work-item-77");
    expect(body.source?.transport).toBe("openclaw");
  });

  it("atlas_execution resolves telegram work thread before submit and preserves distinct atlasTaskId", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/runtime/work-threads/by-topic")) {
        return new Response(JSON.stringify({ workThread: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href.includes("/api/runtime/work-threads/ensure")) {
        return new Response(JSON.stringify({ workThread: { id: "wt-telegram-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === "POST" && href.includes("/api/a2a/tasks")) {
        return new Response(JSON.stringify({ id: "a2a-task-telegram-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools({
      agentChannel: "telegram",
      agentTo: "telegram:group:-100901:topic:4411",
      agentThreadId: "4411",
    }).find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-submit-telegram-thread", {
      action: "submit",
      taskId: "a2a-task-telegram-1",
      atlasTaskId: "atlas-task-telegram-1",
      title: "Telegram thread sync",
      summary: "Keep canonical topic identity",
      repo: "homio/core",
      intent: "implement_feature",
      branch: "feature/telegram-thread-sync",
      envName: "ai02",
      brief: "Submit through the canonical telegram work thread.",
    });

    const details = result.details as { ok?: boolean; result?: { id?: string } };
    expect(details.ok).toBe(true);
    expect(details.result?.id).toBe("a2a-task-telegram-1");

    expect(requestUrlFromCall(fetchMock.mock.calls[0] as unknown as FetchCall)).toContain(
      "/api/runtime/work-threads/by-topic",
    );
    expect(requestUrlFromCall(fetchMock.mock.calls[1] as unknown as FetchCall)).toContain(
      "/api/runtime/work-threads/ensure",
    );

    const ensureBody = parseRequestBody<{
      atlasTaskId?: string;
      branch?: string;
      telegramChatId?: string;
      telegramTopicId?: string;
    }>(fetchMock.mock.calls[1]?.[1]?.body);
    expect(ensureBody.atlasTaskId).toBe("atlas-task-telegram-1");
    expect(ensureBody.branch).toBe("feature/telegram-thread-sync");
    expect(ensureBody.telegramChatId).toBe("-100901");
    expect(ensureBody.telegramTopicId).toBe("4411");

    const [, submitInit] = fetchMock.mock.calls[2] as unknown as FetchCall;
    expect(submitInit).toBeDefined();
    const submitBody = parseRequestBody<{
      atlasTaskId?: string | null;
      executionSpec?: {
        taskId?: string;
        target?: { taskId?: string | null };
        metadata?: Record<string, unknown>;
      };
      metadata?: Record<string, unknown>;
      source?: { transport?: string; chatId?: string | null; threadId?: string | null };
    }>(submitInit?.body);
    expect(submitBody.atlasTaskId).toBe("atlas-task-telegram-1");
    expect(submitBody.executionSpec?.taskId).toBe("a2a-task-telegram-1");
    expect(submitBody.executionSpec?.target?.taskId).toBe("atlas-task-telegram-1");
    expect(submitBody.executionSpec?.metadata?.workThreadId).toBe("wt-telegram-1");
    expect(submitBody.metadata?.workThreadId).toBe("wt-telegram-1");
    expect(submitBody.source?.transport).toBe("telegram-topic");
    expect(submitBody.source?.chatId).toBe("-100901");
    expect(submitBody.source?.threadId).toBe("4411");
  });

  it("atlas_execution rejects submit without a brief before calling Atlas", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    await expect(
      tool.execute("call-atlas-submit-missing-brief", {
        action: "submit",
        taskId: "atlas-task-2",
        intent: "implement_feature",
        sourceTransport: "bitrix",
      }),
    ).rejects.toThrow("brief required");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("atlas_execution rejects telegram-topic submit without topic coordinates", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    await expect(
      tool.execute("call-atlas-submit-missing-topic", {
        action: "submit",
        taskId: "atlas-task-3",
        intent: "implement_feature",
        brief: "Polish the login button.",
        sourceTransport: "telegram-topic",
        sourceChatId: "-100777",
      }),
    ).rejects.toThrow("sourceThreadId required for telegram-topic submissions");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("atlas_execution list does not add an implicit homio/core repo filter", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ tasks: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-list-unfiltered", {
      action: "list",
      limit: 10,
    });

    const details = result.details as { ok?: boolean; result?: { tasks?: unknown[] } };
    expect(details.ok).toBe(true);
    expect(details.result?.tasks).toEqual([]);

    const requestUrl = requestUrlFromCall(fetchMock.mock.calls[0] as unknown as FetchCall);
    expect(requestUrl).toContain("/api/a2a/tasks");
    expect(requestUrl).not.toContain("repo=homio%2Fcore");
  });

  it("atlas_execution list forwards atlas and transport filters when provided", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ tasks: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-list-filtered", {
      action: "list",
      atlasTaskId: "atlas-task-filter-1",
      sourceTransport: "telegram-topic",
      sourceChatId: "-100777",
      sourceThreadId: "4401",
      repo: "homio/core",
      limit: 10,
    });

    const details = result.details as { ok?: boolean; result?: { tasks?: unknown[] } };
    expect(details.ok).toBe(true);
    expect(details.result?.tasks).toEqual([]);

    const requestUrl = requestUrlFromCall(fetchMock.mock.calls[0] as unknown as FetchCall);
    expect(requestUrl).toContain("atlas_task_id=atlas-task-filter-1");
    expect(requestUrl).toContain("source_transport=telegram-topic");
    expect(requestUrl).toContain("source_chat_id=-100777");
    expect(requestUrl).toContain("source_thread_id=4401");
    expect(requestUrl).toContain("repo=homio%2Fcore");
  });

  it("atlas_execution get resolves A2A task id from atlasTaskId when needed", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/a2a/tasks?")) {
        return new Response(JSON.stringify({ tasks: [{ id: "a2a-from-atlas-1" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href.endsWith("/api/a2a/tasks/a2a-from-atlas-1")) {
        return new Response(
          JSON.stringify({
            task: {
              id: "a2a-from-atlas-1",
              atlasTaskId: "atlas-task-recovery-1",
              status: "running",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-get-by-atlas-task-id", {
      action: "get",
      atlasTaskId: "atlas-task-recovery-1",
      repo: "homio/core",
    });

    const details = result.details as {
      ok?: boolean;
      result?: { task?: { id?: string; atlasTaskId?: string; status?: string } };
    };
    expect(details.ok).toBe(true);
    expect(details.result?.task?.id).toBe("a2a-from-atlas-1");
    expect(details.result?.task?.atlasTaskId).toBe("atlas-task-recovery-1");

    const lookupUrl = requestUrlFromCall(fetchMock.mock.calls[0] as unknown as FetchCall);
    expect(lookupUrl).toContain("/api/a2a/tasks?");
    expect(lookupUrl).toContain("atlas_task_id=atlas-task-recovery-1");
    expect(lookupUrl).toContain("repo=homio%2Fcore");
    const getUrl = requestUrlFromCall(fetchMock.mock.calls[1] as unknown as FetchCall);
    expect(getUrl).toContain("/api/a2a/tasks/a2a-from-atlas-1");
  });

  it("atlas_execution prefers an active A2A task when atlasTaskId lookup returns history", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/a2a/tasks?")) {
        return new Response(
          JSON.stringify({
            tasks: [
              {
                id: "a2a-completed-old",
                status: "completed",
                createdAt: "2026-04-01T01:00:00.000Z",
              },
              {
                id: "a2a-running-new",
                status: "running",
                createdAt: "2026-04-01T02:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (href.endsWith("/api/a2a/tasks/a2a-running-new")) {
        return new Response(
          JSON.stringify({
            task: { id: "a2a-running-new", atlasTaskId: "atlas-task-history-1", status: "running" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-get-by-atlas-history", {
      action: "get",
      atlasTaskId: "atlas-task-history-1",
    });

    const details = result.details as {
      ok?: boolean;
      result?: { task?: { id?: string; status?: string } };
    };
    expect(details.ok).toBe(true);
    expect(details.result?.task?.id).toBe("a2a-running-new");
    expect(details.result?.task?.status).toBe("running");
  });

  it("atlas_execution events resolves A2A task id from atlasTaskId when needed", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/a2a/tasks?")) {
        return new Response(JSON.stringify({ tasks: [{ id: "a2a-from-atlas-events" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href.includes("/api/a2a/tasks/a2a-from-atlas-events/events")) {
        return new Response(JSON.stringify({ events: [{ eventType: "task.created" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-events-by-atlas-task-id", {
      action: "events",
      atlasTaskId: "atlas-task-recovery-events",
      limit: 5,
    });

    const details = result.details as {
      ok?: boolean;
      result?: { events?: Array<{ eventType?: string }> };
    };
    expect(details.ok).toBe(true);
    expect(details.result?.events?.[0]?.eventType).toBe("task.created");
  });

  it("atlas_execution get resolves A2A task id from topic source coordinates when ids are absent", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/a2a/tasks?")) {
        return new Response(
          JSON.stringify({ tasks: [{ id: "a2a-from-topic-1", status: "running" }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (href.endsWith("/api/a2a/tasks/a2a-from-topic-1")) {
        return new Response(
          JSON.stringify({
            task: {
              id: "a2a-from-topic-1",
              sourceChatId: "-100777",
              sourceThreadId: "4401",
              status: "running",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-get-by-topic-coords", {
      action: "get",
      sourceTransport: "telegram-topic",
      sourceChatId: "-100777",
      sourceThreadId: "4401",
      repo: "homio/core",
    });

    const details = result.details as {
      ok?: boolean;
      result?: { task?: { id?: string; sourceChatId?: string; sourceThreadId?: string } };
    };
    expect(details.ok).toBe(true);
    expect(details.result?.task?.id).toBe("a2a-from-topic-1");

    const lookupUrl = requestUrlFromCall(fetchMock.mock.calls[0] as unknown as FetchCall);
    expect(lookupUrl).toContain("source_transport=telegram-topic");
    expect(lookupUrl).toContain("source_chat_id=-100777");
    expect(lookupUrl).toContain("source_thread_id=4401");
  });

  it("atlas_execution get can recover from telegram tool context without explicit ids", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/a2a/tasks?")) {
        return new Response(
          JSON.stringify({ tasks: [{ id: "a2a-from-context-1", status: "running" }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (href.endsWith("/api/a2a/tasks/a2a-from-context-1")) {
        return new Response(
          JSON.stringify({
            task: {
              id: "a2a-from-context-1",
              sourceChatId: "-100888",
              sourceThreadId: "5501",
              status: "running",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools({
      agentChannel: "telegram",
      agentTo: "telegram:group:-100888:topic:5501",
      agentThreadId: "5501",
    }).find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    const result = await tool.execute("call-atlas-get-by-context", {
      action: "get",
      repo: "homio/core",
    });

    const details = result.details as { ok?: boolean; result?: { task?: { id?: string } } };
    expect(details.ok).toBe(true);
    expect(details.result?.task?.id).toBe("a2a-from-context-1");
  });

  it("atlas_execution rejects conflicting taskId and atlasTaskId instead of silently trusting taskId", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.endsWith("/api/a2a/tasks/a2a-explicit-1")) {
        return new Response(
          JSON.stringify({
            task: { id: "a2a-explicit-1", atlasTaskId: "atlas-task-other", status: "running" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    await expect(
      tool.execute("call-atlas-get-conflicting-ids", {
        action: "get",
        taskId: "a2a-explicit-1",
        atlasTaskId: "atlas-task-expected",
      }),
    ).rejects.toThrow("taskId a2a-explicit-1 does not match atlasTaskId atlas-task-expected");
  });

  it("atlas_execution rejects source-based recovery without full topic coordinates", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = createOpenClawTools().find((candidate) => candidate.name === "atlas_execution");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing atlas_execution tool");
    }

    await expect(
      tool.execute("call-atlas-get-ambiguous-source", {
        action: "get",
        sourceTransport: "telegram-topic",
        sourceChatId: "-100777",
      }),
    ).rejects.toThrow("sourceChatId and sourceThreadId required for source-based task recovery");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
