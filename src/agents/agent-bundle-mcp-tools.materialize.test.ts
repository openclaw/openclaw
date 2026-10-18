/** Tests materializing MCP catalog tools into agent tool definitions and results. */

import "../test-utils/prepare-compiled-subprocesses.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createCombinedSessionMcpRuntime } from "./agent-bundle-mcp-combined.js";
import {
  buildBundleMcpToolsFromCatalog,
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import { catalogTool, makeCatalog, makeMcpRuntime } from "./agent-bundle-mcp-tools.test-support.js";
import type {
  BundleMcpToolRuntime,
  McpCatalogTool,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { getMcpAppViewLease } from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";
import { isToolResultError } from "./tool-result-error.js";

const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

function firstTool(runtime: Pick<BundleMcpToolRuntime, "tools">) {
  return expectDefined(runtime.tools[0], "first materialized tool");
}

const knowledgeServer = {
  safeServerName: "knowledge",
  resources: { listChanged: false },
  prompts: { listChanged: false },
};

function makeToolRuntime(
  params: {
    tools?: McpCatalogTool[];
    serverName?: string;
    result?: CallToolResult;
    supportsParallelToolCalls?: boolean;
  } = {},
): SessionMcpRuntime {
  const serverName = params.serverName ?? "bundleProbe";
  const tools = params.tools ?? [catalogTool(serverName, "bundle_probe")];
  const peekCatalog = () =>
    makeCatalog(serverName, tools, {
      supportsParallelToolCalls: params.supportsParallelToolCalls ?? false,
    });
  return makeMcpRuntime(
    peekCatalog,
    () =>
      params.result ?? {
        content: [{ type: "text", text: "FROM-BUNDLE" }],
        isError: false,
      },
    {
      joinCleanup: async () => {},
    },
  );
}

async function executeMcpToolResult(result: CallToolResult) {
  const runtime = await materializeBundleMcpToolsForRun({
    runtime: makeToolRuntime({ result }),
  });
  return firstTool(runtime).execute("call-bundle-probe", {}, undefined, undefined);
}

describe("createBundleMcpToolRuntime", () => {
  afterEach(() => {
    mcpUiResourceTesting.clearViewStore();
    vi.restoreAllMocks();
  });

  it("joins concurrent disposal without releasing the captured lease twice", async () => {
    const closing = createDeferred();
    const started = createDeferred();
    const releaseLease = vi.fn();
    const runtime = makeToolRuntime();
    runtime.acquireLease = () => releaseLease;
    const disposeRuntime = vi.fn(async () => {
      started.resolve();
      await closing.promise;
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime, disposeRuntime });
    const first = materialized.dispose();
    await started.promise;
    let joined = false;
    const second = materialized.dispose().then(() => {
      joined = true;
    });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(joined).toBe(false);
      expect(releaseLease).toHaveBeenCalledOnce();
    } finally {
      closing.resolve();
      await Promise.all([first, second]);
    }
    expect(disposeRuntime).toHaveBeenCalledOnce();
  });

  it.each(["joinCleanup", "dispose"] as const)(
    "replays a combined owner's synchronous %s failure in each final caller",
    async (failureAt) => {
      const failed = makeToolRuntime();
      const sibling = makeToolRuntime();
      sibling.dispose = vi.fn(async () => {});
      sibling.joinCleanup = vi.fn(async () => {});
      const failure = new Error("cleanup owner lost");
      const failingCleanup = vi.fn(() => {
        throw failure;
      });
      failed[failureAt] = failingCleanup;
      const runtime = createCombinedSessionMcpRuntime({
        sessionId: failed.sessionId,
        workspaceDir: failed.workspaceDir,
        parts: [failed, sibling],
      });
      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      if (failureAt === "dispose") {
        // The physical failure predates both final callers' cleanup contexts.
        await runtime.dispose();
        await runtime.dispose();
        expect(failingCleanup).toHaveBeenCalledOnce();
        expect(sibling.dispose).toHaveBeenCalledOnce();
      }
      for (let index = 0; index < 2; index += 1) {
        const cleanupScope = createAgentCleanupScope();
        await cleanupScope.run(async () => {
          await expect(materialized.dispose()).rejects.toBe(failure);
        });
        expect(cleanupScope.outcome).toBe("uncertain");
      }
      expect(sibling.joinCleanup).toHaveBeenCalled();
    },
  );

  it("keeps an unreported shared cleanup owner uncertain without closing its peers", async () => {
    const runtime = makeToolRuntime();
    delete runtime.joinCleanup;
    const dispose = vi.spyOn(runtime, "dispose");
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    const cleanupScope = createAgentCleanupScope();
    await cleanupScope.run(() => materialized.dispose());
    expect(cleanupScope.outcome).toBe("uncertain");
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each([
    { catalogOutcome: "resolve", cleanupFault: "dispose" },
    { catalogOutcome: "reject", cleanupFault: "join" },
  ] as const)(
    "preserves private $cleanupFault failure when a cancelled catalog will $catalogOutcome",
    async ({ catalogOutcome, cleanupFault }) => {
      const runtime = makeToolRuntime();
      const readCatalog = runtime.getCatalog;
      const entered = createDeferred();
      const cleanupStarted = createDeferred();
      const finishCleanup = createDeferred();
      const cleanupFailure = new Error("private MCP cleanup could not confirm closure");
      const releaseLease = vi.fn();
      runtime.acquireLease = () => releaseLease;
      runtime.getCatalog = async () => {
        entered.resolve();
        await cleanupStarted.promise;
        if (catalogOutcome === "reject") {
          throw new Error("catalog closed during cancellation");
        }
        return readCatalog();
      };
      runtime.dispose = async () => {
        cleanupStarted.resolve();
        await finishCleanup.promise;
        if (cleanupFault === "dispose") {
          throw cleanupFailure;
        }
      };
      runtime.joinCleanup = async () => {
        await finishCleanup.promise;
        if (cleanupFault === "join") {
          throw cleanupFailure;
        }
      };
      const runtimeModule = await import("./agent-bundle-mcp-runtime.js");
      vi.spyOn(runtimeModule, "createSessionMcpRuntime").mockReturnValueOnce(runtime);
      const work = new AsyncWorkScope();
      const cleanupScope = createAgentCleanupScope();
      const pending = cleanupScope.run(() =>
        work.track(() => createBundleMcpToolRuntime({ workspaceDir: "/tmp" })),
      );
      let settled = false;
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      try {
        await entered.promise;
        work.beginClose(new Error("private MCP acquisition cancelled"));
        await withTestTimeout(cleanupStarted.promise, 1_000, "Private MCP cleanup did not start");
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        finishCleanup.resolve();
        await expect(pending).rejects.toBe(cleanupFailure);
        expect(releaseLease).toHaveBeenCalledOnce();
        expect(cleanupScope.outcome).toBe("uncertain");
      } finally {
        cleanupStarted.resolve();
        finishCleanup.resolve();
        await pending.catch(() => {});
        await work.drain();
      }
    },
  );

  it.each([
    { failureAt: "catalog", cleanupFault: "dispose", outcome: "uncertain" },
    { failureAt: "acquire", cleanupFault: "none", outcome: "closed" },
    { failureAt: "dispose", cleanupFault: "release", outcome: "uncertain" },
  ] as const)(
    "settles every private cleanup step after $failureAt fails ($cleanupFault)",
    async ({ failureAt, cleanupFault, outcome }) => {
      const runtime = makeToolRuntime();
      const cause = new Error("preparation failed");
      const releaseFailure = new Error("lease release failed");
      if (failureAt === "catalog") {
        runtime.getCatalog = vi.fn().mockRejectedValue(cause);
      }
      runtime.acquireLease = () => {
        if (failureAt === "acquire") {
          throw cause;
        }
        return () => {
          if (cleanupFault === "release") {
            throw releaseFailure;
          }
        };
      };
      runtime.dispose =
        cleanupFault === "dispose"
          ? vi.fn().mockRejectedValue(new Error("cleanup failed"))
          : vi.fn(async () => {});
      runtime.joinCleanup = vi.fn(async () => {});
      const runtimeModule = await import("./agent-bundle-mcp-runtime.js");
      vi.spyOn(runtimeModule, "createSessionMcpRuntime").mockReturnValueOnce(runtime);
      const cleanupScope = createAgentCleanupScope();
      await cleanupScope.run(async () => {
        await expect(
          (async () => {
            const materialized = await createBundleMcpToolRuntime({
              workspaceDir: "/tmp",
            });
            await materialized.dispose();
          })(),
        ).rejects.toBe(failureAt === "dispose" ? releaseFailure : cause);
      });
      expect(runtime.dispose).toHaveBeenCalledOnce();
      expect(runtime.joinCleanup).toHaveBeenCalledOnce();
      expect(cleanupScope.outcome).toBe(outcome);
    },
  );

  it.each([false, true])(
    "preserves image previews but never mints requester-scoped views (%s)",
    async (scoped) => {
      const serverName = scoped ? "user-mail" : "demo";
      const uri = `ui://${serverName}/app`;
      const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } as const;
      const tool = catalogTool(serverName, "show", {
        inputSchema: { type: "object" },
        uiResourceUri: uri,
      });
      const sessionRuntime = makeToolRuntime({
        tools: [tool],
        serverName,
        result: scoped
          ? undefined
          : {
              content: [image],
              _meta: { "ui/state": { selected: true } },
            },
      });
      sessionRuntime.mcpAppsEnabled = true;
      if (scoped) {
        // Recovery has no requester identity; private servers stay fail-closed.
        sessionRuntime.isRequesterScopedServer = (name) => name === serverName;
      } else {
        sessionRuntime.sessionKey = "agent:main:main";
        sessionRuntime.readResource = async () => ({
          contents: [{ uri, mimeType: MCP_APP_RESOURCE_MIME_TYPE, text: "<html>demo</html>" }],
        });
      }
      const materialized = await materializeBundleMcpToolsForRun({ runtime: sessionRuntime });
      if (!scoped) {
        materialized.restrictAppTools?.(materialized.tools);
      }
      const result = await firstTool(materialized).execute("call-1", {}, undefined, undefined);
      if (scoped) {
        expect(result.details ?? {}).not.toHaveProperty("mcpAppPreview");
        return;
      }
      expect(result.content).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
      expect(result.details).toMatchObject({
        mcpAppPreview: {
          mcpApp: {
            viewId: expect.stringMatching(/^mcp-app-/u),
            serverName: "demo",
            toolName: "show",
            uiResourceUri: "ui://demo/app",
            toolCallId: "call-1",
            originSessionKey: "agent:main:main",
            resultMetaState: "unavailable",
          },
        },
      });
      const viewId = (result.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } })
        .mcpAppPreview?.mcpApp?.viewId;
      expect(
        getMcpAppViewLease(
          expectDefined(viewId, "MCP App preview view id test invariant"),
          sessionRuntime,
        )?.allowedAppToolNames,
      ).toEqual(new Set(["show"]));
    },
  );

  it("marks MCP tools parallel only when the server advertises parallel support", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        supportsParallelToolCalls: true,
      }),
    });

    expect(firstTool(runtime).executionMode).toBe("parallel");
  });

  it("marks isError through the tool-result owner while preserving recovery text", async () => {
    const result = await executeMcpToolResult({
      content: [{ type: "text", text: "authentication expired; run login" }],
      structuredContent: { retryable: true },
      isError: true,
    });

    expect(result.content).toContainEqual({
      type: "text",
      text: "authentication expired; run login",
    });
    expect(result.details).toMatchObject({
      status: "error",
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
      structuredContent: { retryable: true },
    });
    expect(isToolResultError(result)).toBe(true);
  });

  it("coerces resource, audio, and malformed image blocks while preserving text and images", async () => {
    // resource_link/resource/audio blocks have no base64 image source; if they
    // leaked into the provider image branch Anthropic would 400 on an image with
    // undefined data/media_type and poison the whole session history (#90710).
    const result = await executeMcpToolResult({
      content: [
        { type: "text", text: "intro" },
        {
          type: "resource_link",
          uri: "https://example.com/a.docx",
          name: "a.docx",
          title: "Quarterly report",
        },
        {
          type: "resource_link",
          uri: "https://example.com/bare",
          name: "",
        },
        {
          type: "resource",
          resource: { uri: "memo://one", text: "memo body" },
        },
        {
          type: "resource",
          resource: { uri: "blob://two", blob: "AAAA", mimeType: "application/pdf" },
        },
        { type: "audio", data: "AAAA", mimeType: "audio/mpeg" },
        { type: "image", data: "iVBOR", mimeType: "image/png" },
        // Malformed images must not leak into the provider image branch either.
        { type: "image" } as unknown as CallToolResult["content"][number],
      ],
      isError: false,
    });

    expect(result.content).toEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "[Quarterly report] https://example.com/a.docx" },
      { type: "text", text: "https://example.com/bare" },
      { type: "text", text: "memo body" },
      { type: "text", text: "blob://two" },
      { type: "text", text: "[audio audio/mpeg]" },
      { type: "image", data: "iVBOR", mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ type: "image" }) },
    ]);
    expect(result.details).toEqual({ mcpServer: "bundleProbe", mcpTool: "bundle_probe" });
  });

  it.each([false, true])(
    "disambiguates reserved names, including App-only projections (%s)",
    async (appOnly) => {
      function* reservedToolNames() {
        yield "bundleProbe__bundle_probe";
      }
      const runtime = await materializeBundleMcpToolsForRun({
        runtime: makeToolRuntime({
          tools: [
            catalogTool("bundleProbe", "bundle_probe", appOnly ? { uiVisibility: ["app"] } : {}),
          ],
        }),
        reservedToolNames: reservedToolNames(),
      });
      expect(runtime.tools.map((tool) => tool.name)).toEqual(
        appOnly ? [] : ["bundleProbe__bundle_probe-2"],
      );
      if (appOnly) {
        expect(runtime.appTools?.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe-2"]);
      }
    },
  );

  it("applies per-server MCP tool filters to resource and prompt utility tools", async () => {
    const base = makeToolRuntime({ tools: [], serverName: "knowledge" });
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: {
        ...base,
        getCatalog: async () =>
          makeCatalog("knowledge", [], {
            ...knowledgeServer,
            toolFilter: { include: ["resources_*"], exclude: ["resources_read"] },
          }),
        listResources: async () => [],
        readResource: async () => ({ contents: [] }),
        listPrompts: async () => [],
        getPrompt: async () => ({ messages: [] }),
      },
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["knowledge__resources_list"]);
  });

  it("projects resource and prompt utility tools for inventory-only catalogs", async () => {
    const tools = buildBundleMcpToolsFromCatalog({
      catalog: makeCatalog("knowledge", [], knowledgeServer),
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "knowledge__prompts_get",
      "knowledge__prompts_list",
      "knowledge__resources_list",
      "knowledge__resources_read",
    ]);
    await expect(
      firstTool({ tools }).execute("inventory-only", {}, undefined, undefined),
    ).rejects.toThrow("bundle-mcp catalog projection cannot execute tools");
  });

  it("projects session-denied tools only for read-only inventory", () => {
    const catalog = {
      ...makeCatalog("knowledge", [], {
        ...knowledgeServer,
        prompts: undefined,
        deniedToolNames: ["resources_read"],
      }),
      tools: [
        catalogTool("knowledge", "alpha?", { fallbackDescription: "Enabled knowledge tool" }),
      ],
      sessionDeniedTools: [
        catalogTool("knowledge", "alpha!", {
          fallbackDescription: "Denied knowledge tool",
          deniedBySession: true,
        }),
      ],
    } satisfies Parameters<typeof buildBundleMcpToolsFromCatalog>[0]["catalog"];

    expect(buildBundleMcpToolsFromCatalog({ catalog }).map((tool) => tool.name)).toEqual([
      "knowledge__alpha-",
      "knowledge__resources_list",
    ]);
    const inventoryTools = buildBundleMcpToolsFromCatalog({
      catalog,
      includeSessionDenied: true,
    });
    expect(
      inventoryTools.map((tool) => ({
        name: tool.name,
        deniedBySession: getPluginToolMeta(tool)?.mcp?.deniedBySession,
      })),
    ).toEqual([
      { name: "knowledge__alpha-", deniedBySession: undefined },
      { name: "knowledge__alpha--2", deniedBySession: true },
      { name: "knowledge__resources_list", deniedBySession: undefined },
      { name: "knowledge__resources_read", deniedBySession: true },
    ]);
  });

  it("keeps root fields callable when an MCP input schema uses a root union (#128743)", async () => {
    const inputSchema = {
      type: "object",
      title: "MessagesReplyInput",
      additionalProperties: false,
      required: ["thread_id"],
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 128 },
        body: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
        body_file: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
      },
      anyOf: [
        { required: ["body"], properties: { body: { type: "string" } } },
        { required: ["body_file"], properties: { body_file: { type: "string" } } },
      ],
    };
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        serverName: "aihub",
        tools: [
          catalogTool("aihub", "messages_reply", {
            inputSchema,
            fallbackDescription: "Reply to a message",
          }),
        ],
      }),
    });
    const tool = firstTool(runtime);

    for (const args of [{ body: "hello" }, { body_file: "/tmp/body.md" }]) {
      expect(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "call-body",
          name: tool.name,
          arguments: { thread_id: "thread-1", ...args },
        }),
      ).not.toThrow();
    }
  });
});
