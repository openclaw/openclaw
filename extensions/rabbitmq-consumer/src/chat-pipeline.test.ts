import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginLogger, PluginRuntime } from "../api.js";
import { processChatMessage } from "./chat-pipeline.js";
import type { DownloadManager } from "./download-manager.js";
import type { HistoryManager } from "./history-manager.js";
import type { ReportTemplateLookup } from "./report-template-lookup.js";
import type { TopicResolver } from "./topic-resolver.js";
import type { ChatMessage, MercureConfig } from "./types.js";

type AgentEventListener = (evt: {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
}) => void;

const USER_ID = "42";
const SESSION_ID = "s1";
const SESSION_KEY = `agent:rabbitmq-${USER_ID}:rabbitmq:${USER_ID}:${SESSION_ID}`;

function createChatMessage(): ChatMessage {
  return {
    historyId: 1,
    message: "hi there",
    sessionId: SESSION_ID,
    userId: USER_ID,
    useMemory: true,
    useWebsearch: false,
  };
}

function createHistoryManagerMock() {
  const updateResponse = vi.fn(async () => {});
  const historyManager = {
    getRecord: async () => ({
      id: 1,
      sessionId: SESSION_ID,
      userId: USER_ID,
      message: "hi there",
      response: null,
      toolsUsed: null,
      metadata: null,
      createdAt: new Date(),
    }),
    updateResponse,
  } as unknown as HistoryManager;
  return { historyManager, updateResponse };
}

function createRuntimeMock(options: {
  workspaceDir: string;
  onRun: (listener: AgentEventListener | undefined) => void;
  sessionMessages?: unknown[];
  onRunArgs?: (args: { message: string }) => void;
}): PluginRuntime {
  let listener: AgentEventListener | undefined;
  return {
    events: {
      onAgentEvent: (fn: AgentEventListener) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
    subagent: {
      run: async (args: { message: string }) => {
        options.onRunArgs?.(args);
        options.onRun(listener);
        return { runId: "r1" };
      },
      waitForRun: async () => ({ status: "ok" as const }),
      getSessionMessages: async () => ({ messages: options.sessionMessages ?? [] }),
    },
    agent: {
      resolveAgentWorkspaceDir: () => options.workspaceDir,
    },
  } as unknown as PluginRuntime;
}

describe("processChatMessage", () => {
  let workspaceDir: string;
  const mercureConfig: MercureConfig = {
    hubUrl: "http://127.0.0.1:9/.well-known/mercure",
    jwtSecret: "test-secret",
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as PluginLogger;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "chat-pipeline-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("forwards only assistant deltas matching this run's sessionKey", async () => {
    // Regression: the listener used to forward EVERY assistant delta in the
    // gateway process; concurrent runs (report subagent, other sessions)
    // leaked into this user's stream as a second "typing" bubble.
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "assistant",
          ts: 1,
          sessionKey: SESSION_KEY,
          data: { delta: "hello" },
        });
        // Concurrent report subagent for another user — must be dropped.
        listener?.({
          runId: "r2",
          seq: 1,
          stream: "assistant",
          ts: 2,
          sessionKey: "agent:rabbitmq-99:report-gen:99:1700000000000",
          data: { delta: "LEAK" },
        });
        // Event without sessionKey — must be dropped.
        listener?.({
          runId: "r3",
          seq: 1,
          stream: "assistant",
          ts: 3,
          data: { delta: "NOKEY" },
        });
        // Non-assistant stream — must be dropped.
        listener?.({
          runId: "r1",
          seq: 2,
          stream: "tool",
          ts: 4,
          sessionKey: SESSION_KEY,
          data: { delta: "TOOL" },
        });
      },
    });
    const { historyManager, updateResponse } = createHistoryManagerMock();

    const result = await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(result).toBe("hello");
    expect(result).not.toContain("LEAK");
    expect(updateResponse).toHaveBeenCalledWith(1, "hello");
  });

  it("tags every chat Mercure push with the originating historyId", async () => {
    // Regression: text/done events carried no turn identifier, so a stale SSE
    // subscription on the shared per-user topic rendered the next turn's
    // chunks into an old chat bubble ("output before the question").
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "assistant",
          ts: 1,
          sessionKey: SESSION_KEY,
          data: { delta: "hello" },
        });
      },
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(createChatMessage(), historyManager, mercureConfig, runtime, logger);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const payloads = fetchMock.mock.calls.map((call) => {
      // The pusher always sends a URL-encoded string body.
      const init = call[1] as { body?: string };
      const params = new URLSearchParams(init.body ?? "");
      return JSON.parse(params.get("data") ?? "{}") as Record<string, unknown>;
    });

    const textEvents = payloads.filter((p) => p.type === "text");
    const doneEvents = payloads.filter((p) => p.type === "done");
    expect(textEvents.length).toBeGreaterThan(0);
    expect(doneEvents).toHaveLength(1);
    for (const evt of [...textEvents, ...doneEvents]) {
      expect(evt.historyId).toBe(1);
    }
  });

  it("pushes sanitized progress events for tool starts, never leaking args", async () => {
    // While the agent runs tools (DB queries) it emits no assistant deltas;
    // the frontend used to see nothing for the whole tool phase. Tool starts
    // must surface as `progress` events carrying only a generic label.
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "tool",
          ts: 1,
          sessionKey: SESSION_KEY,
          data: {
            phase: "start",
            name: "exec",
            toolCallId: "t1",
            args: { command: "mysql -uroot -pSECRET -e 'SELECT 1'" },
          },
        });
        // Tool event from a foreign session — must be dropped.
        listener?.({
          runId: "r2",
          seq: 1,
          stream: "tool",
          ts: 2,
          sessionKey: "agent:rabbitmq-99:rabbitmq:99:other",
          data: { phase: "start", name: "exec", toolCallId: "t2" },
        });
        listener?.({
          runId: "r1",
          seq: 2,
          stream: "assistant",
          ts: 3,
          sessionKey: SESSION_KEY,
          data: { delta: "answer" },
        });
      },
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(createChatMessage(), historyManager, mercureConfig, runtime, logger);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const payloads = fetchMock.mock.calls.map((call) => {
      const init = call[1] as { body?: string };
      const params = new URLSearchParams(init.body ?? "");
      return JSON.parse(params.get("data") ?? "{}") as Record<string, unknown>;
    });

    // Progress now includes an immediate "理解问题" ack pushed at run start,
    // followed by the sanitized tool-activity line. Assert the tool line is
    // present and correctly tagged rather than pinning the exact count.
    const progressEvents = payloads.filter((p) => p.type === "progress");
    const toolProgress = progressEvents.find(
      (p) => p.content === "正在查询分析数据（第 1 步）…",
    );
    expect(toolProgress).toBeDefined();
    expect(toolProgress?.historyId).toBe(1);
    for (const evt of payloads) {
      expect(JSON.stringify(evt)).not.toContain("SECRET");
      expect(JSON.stringify(evt)).not.toContain("SELECT");
    }
  });

  it("prefers the latest assistant session message as the canonical response", async () => {
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "assistant",
          ts: 1,
          sessionKey: SESSION_KEY,
          data: { delta: "partial stream" },
        });
      },
      sessionMessages: [
        { role: "user", content: "hi there" },
        { role: "assistant", content: "full canonical answer" },
      ],
    });
    const { historyManager, updateResponse } = createHistoryManagerMock();

    const result = await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(result).toBe("full canonical answer");
    expect(updateResponse).toHaveBeenCalledWith(1, "full canonical answer");
  });

  it("extracts text from array-form (block) assistant content without throwing", async () => {
    // Regression: tool-using sessions return content as content blocks, not a
    // string. The pipeline used to assign the raw array to fullResponse, which
    // crashed once the output sanitizer called .replace ("text.replace is not a
    // function"). It must extract the text and persist the string.
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      sessionMessages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "块状内容答案" }] },
      ],
    });
    const { historyManager, updateResponse } = createHistoryManagerMock();

    const result = await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(result).toBe("块状内容答案");
    expect(updateResponse).toHaveBeenCalledWith(1, "块状内容答案");
  });

  it("injects the resolved topic ownership into the subagent message", async () => {
    // Regression: the chat path used to pass only [userId:...], forcing the
    // agent to guess project ownership from the DB (it once reused a stale
    // hardcoded topic-id list). entity_auth is the source of truth.
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async (uid: string) => {
        expect(uid).toBe(USER_ID);
        return {
          topicId: 585,
          useSlaveTopic: true,
          masterId: 270,
          topicName: "广本监测专项",
          topics: [{ topicId: 585, useSlaveTopic: true, masterId: 270, topicName: "广本监测专项" }],
        };
      },
    } as unknown as TopicResolver;

    await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(capturedMessage).toBe(
      `[userId:${USER_ID}] [topicId:585 topicName:"广本监测专项" useSlaveTopic:true] hi there`,
    );
  });

  it("lists every owned topic when the user has more than one", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 585,
        useSlaveTopic: false,
        masterId: 585,
        topicName: "专题E",
        topics: [
          { topicId: 116, useSlaveTopic: false, masterId: 116, topicName: "专题A" },
          { topicId: 357, useSlaveTopic: false, masterId: 357, topicName: null },
          { topicId: 585, useSlaveTopic: false, masterId: 585, topicName: "专题E" },
        ],
      }),
    } as unknown as TopicResolver;

    await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(capturedMessage).toBe(
      `[userId:${USER_ID}] [topicId:585 topicName:"专题E" useSlaveTopic:false]` +
        ` [allTopics: 116:"专题A", 357, 585:"专题E"] hi there`,
    );
  });

  it("escapes quotes and brackets in topicName via JSON.stringify", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 585,
        useSlaveTopic: true,
        masterId: 270,
        topicName: '专项[A] "测试"',
        topics: [{ topicId: 585, useSlaveTopic: true, masterId: 270, topicName: '专项[A] "测试"' }],
      }),
    } as unknown as TopicResolver;

    await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(capturedMessage).toBe(
      `[userId:${USER_ID}] [topicId:585 topicName:"专项[A] \\"测试\\"" useSlaveTopic:true] hi there`,
    );
  });

  it("omits topicName from the prefix when the title lookup returned null", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 585,
        useSlaveTopic: true,
        masterId: 270,
        topicName: null,
        topics: [{ topicId: 585, useSlaveTopic: true, masterId: 270, topicName: null }],
      }),
    } as unknown as TopicResolver;

    await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(capturedMessage).toBe(`[userId:${USER_ID}] [topicId:585 useSlaveTopic:true] hi there`);
  });

  it("falls back to the plain userId prefix when topic resolution fails", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => {
        throw new Error("db down");
      },
    } as unknown as TopicResolver;

    const result = await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(result).toBe("ok");
    expect(capturedMessage).toBe(`[userId:${USER_ID}] hi there`);
  });

  it("omits topic context when the user has no topic mapping", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: null,
        useSlaveTopic: false,
        masterId: 0,
        topicName: null,
        topics: [],
      }),
    } as unknown as TopicResolver;

    await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(capturedMessage).toBe(`[userId:${USER_ID}] hi there`);
  });

  it("queues an explicit template-driven report and bypasses the chat subagent", async () => {
    // The frontend's template panel sends a report_template.id. Its own period
    // (not message keywords) drives the report, and the chat subagent is never
    // run for this turn.
    const createReportTask = vi.fn(async (_args: Record<string, unknown>) => 123);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    const resolve = vi.fn(async () => ({ id: 7, period: "周报" as const, name: "我的周报" }));
    const templateLookup = { resolve } as unknown as ReportTemplateLookup;

    let ranSubagent = false;
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {
        ranSubagent = true;
      },
      sessionMessages: [{ role: "assistant", content: "should not be used" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 585,
        useSlaveTopic: false,
        masterId: 585,
        topicName: "专题E",
        topics: [{ topicId: 585, useSlaveTopic: false, masterId: 585, topicName: "专题E" }],
      }),
    } as unknown as TopicResolver;

    const chatMsg: ChatMessage = { ...createChatMessage(), message: "重点关注负面", templateId: 7 };
    const result = await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      topicResolver,
      undefined,
      undefined,
      templateLookup,
    );

    expect(resolve).toHaveBeenCalledWith(7, USER_ID, logger);
    expect(createReportTask).toHaveBeenCalledTimes(1);
    const taskArg = createReportTask.mock.calls[0][0] as unknown as {
      period: string;
      templateId?: number;
      topicId: number;
      requirement: string;
    };
    expect(taskArg.period).toBe("周报");
    expect(taskArg.templateId).toBe(7);
    expect(taskArg.topicId).toBe(585);
    expect(taskArg.requirement).toBe("重点关注负面");
    expect(result).toContain("周报报告已创建");
    // Report path returns before the chat subagent runs.
    expect(ranSubagent).toBe(false);
  });

  it("routes the report to the requirement-named topic, not just the primary", async () => {
    // Regression: the report path used only resolution.topicId (the most
    // recently granted topic), so a multi-project user asking for "南方基金"
    // got their default project's report. The requirement name must win within
    // the authorized topic set.
    const createReportTask = vi.fn(async (_args: Record<string, unknown>) => 1);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    const resolve = vi.fn(async () => ({ id: 4, period: "日报" as const, name: "火灾速报" }));
    const templateLookup = { resolve } as unknown as ReportTemplateLookup;
    const runtime = createRuntimeMock({ workspaceDir, onRun: () => {} });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 89, // primary = most recently granted
        useSlaveTopic: false,
        masterId: 89,
        topicName: "广汽本田",
        topics: [
          { topicId: 89, useSlaveTopic: false, masterId: 89, topicName: "广汽本田" },
          { topicId: 204, useSlaveTopic: false, masterId: 204, topicName: "南方基金" },
        ],
      }),
    } as unknown as TopicResolver;

    const chatMsg: ChatMessage = {
      ...createChatMessage(),
      message: "用这个模板做一个南方基金6月3号到6月8号的报告",
      templateId: 4,
    };
    await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      topicResolver,
      undefined,
      undefined,
      templateLookup,
    );

    const taskArg = createReportTask.mock.calls[0][0] as unknown as { topicId: number };
    expect(taskArg.topicId).toBe(204);
  });

  it("routes the report to the LLM-chosen topic over the substring match", async () => {
    // The requirement text substring-matches 南方基金 (#204), but the LLM
    // classifier resolves intent to 招商证券 (#305). The LLM pick is
    // authoritative when it returns a valid authorized topic; only on an
    // unavailable/unsure model do we fall back to substring matching.
    const createReportTask = vi.fn(async (_args: Record<string, unknown>) => 1);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    const resolve = vi.fn(async () => ({ id: 4, period: "日报" as const, name: "火灾速报" }));
    const templateLookup = { resolve } as unknown as ReportTemplateLookup;
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      sessionMessages: [{ role: "assistant", content: '好的 {"topicId": 305}' }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 89,
        useSlaveTopic: false,
        masterId: 89,
        topicName: "广汽本田",
        topics: [
          { topicId: 89, useSlaveTopic: false, masterId: 89, topicName: "广汽本田" },
          { topicId: 204, useSlaveTopic: false, masterId: 204, topicName: "南方基金" },
          { topicId: 305, useSlaveTopic: false, masterId: 305, topicName: "招商证券" },
        ],
      }),
    } as unknown as TopicResolver;

    const chatMsg: ChatMessage = {
      ...createChatMessage(),
      message: "用这个模板做一个南方基金6月的报告",
      templateId: 4,
    };
    await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      topicResolver,
      undefined,
      undefined,
      templateLookup,
    );

    const taskArg = createReportTask.mock.calls[0][0] as unknown as { topicId: number };
    expect(taskArg.topicId).toBe(305);
  });

  it("does not alter the subagent message when use_memory is true (default)", async () => {
    // Regression guard: the memory directive must be empty on the default path so
    // recall (and the existing message format) stays intact.
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(
      { ...createChatMessage(), useMemory: true },
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(capturedMessage).toBe(`[userId:${USER_ID}] hi there`);
    expect(capturedMessage).not.toContain("no-memory");
  });

  it("prefixes a no-memory directive when use_memory is false", async () => {
    // use_memory:false must reach the agent: memory tools are agent-level and
    // cannot be removed per-run, so we suppress recall via a prompt directive.
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(
      { ...createChatMessage(), useMemory: false },
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(capturedMessage).toContain("[no-memory]");
    expect(capturedMessage).toContain("memory_search");
    // The directive prefixes — it never replaces — the user payload.
    expect(capturedMessage).toContain(`[userId:${USER_ID}] hi there`);
  });

  it("falls through to normal chat when the templateId does not resolve", async () => {
    // A deleted / disabled / foreign templateId must not silently drop the
    // turn: it degrades to ordinary chat handling.
    const createReportTask = vi.fn(async () => 1);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    const templateLookup = {
      resolve: vi.fn(async () => null),
    } as unknown as ReportTemplateLookup;

    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      sessionMessages: [{ role: "assistant", content: "normal answer" }],
    });
    const { historyManager } = createHistoryManagerMock();

    const chatMsg: ChatMessage = { ...createChatMessage(), message: "hi there", templateId: 999 };
    const result = await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      undefined,
      undefined,
      undefined,
      templateLookup,
    );

    expect(createReportTask).not.toHaveBeenCalled();
    expect(result).toBe("normal answer");
  });
});
