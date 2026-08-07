/**
 * Integration tests for the MCP query-registry workflow.
 *
 * These tests use a real SessionMcpRuntime connected to the fake query-registry
 * MCP server fixture. They prove that the runtime discovers the tools and that
 * the fixture enforces the correct call order and boundary conditions.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cleanupBundleMcpHarness } from "./agent-bundle-mcp-test-harness.js";
import {
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-tools.js";
import { QUERY_REGISTRY_TOOLS, writeQueryRegistryMcpServer } from "./mcp-query-registry.fixture.js";

type TestRuntime = Awaited<ReturnType<typeof getOrCreateSessionMcpRuntime>>;

async function createQueryRegistryRuntime(params: {
  serverPath: string;
  sessionKey: string;
}): Promise<TestRuntime> {
  return await getOrCreateSessionMcpRuntime({
    sessionId: "session-query-registry",
    sessionKey: params.sessionKey,
    workspaceDir: "/workspace",
    cfg: {
      mcp: {
        servers: {
          queryRegistry: {
            command: process.execPath,
            args: [params.serverPath],
          },
        },
      },
    },
  });
}

async function makeTempFixture(tempDirs: { make: (prefix: string) => string }) {
  const tempDir = tempDirs.make("query-registry-");
  const serverPath = path.join(tempDir, "query-registry-server.mjs");
  const logPath = path.join(tempDir, "server.log");
  await writeQueryRegistryMcpServer(serverPath, { logPath });
  return { serverPath };
}

async function expectTextContentBlock(block: unknown, text: string) {
  const content = block as { type?: string; text?: string } | undefined;
  expect(content?.type).toBe("text");
  expect(content?.text).toBe(text);
}

describe("MCP query-registry workflow", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let sessionSeq = 0;

  afterEach(async () => {
    await cleanupBundleMcpHarness();
  });

  it("discovers the four query-registry tools in the catalog", async () => {
    const { serverPath } = await makeTempFixture(tempDirs);
    const sessionKey = `agent:test:query-registry:${sessionSeq++}`;
    const runtime = await createQueryRegistryRuntime({ serverPath, sessionKey });

    try {
      const catalog = await runtime.getCatalog();
      const toolNames = catalog.tools.map((tool) => tool.toolName).toSorted();
      expect(toolNames).toEqual([
        QUERY_REGISTRY_TOOLS.CONTEXT,
        QUERY_REGISTRY_TOOLS.QUERIES_LIST,
        QUERY_REGISTRY_TOOLS.QUERY_DESCRIBE,
        QUERY_REGISTRY_TOOLS.QUERY_EXECUTE,
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("executes the happy path: context -> list -> describe -> execute", async () => {
    const { serverPath } = await makeTempFixture(tempDirs);
    const sessionKey = `agent:test:query-registry:${sessionSeq++}`;
    const runtime = await createQueryRegistryRuntime({ serverPath, sessionKey });

    try {
      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      const findTool = (name: string) => {
        const tool = materialized.tools.find((t) => t.name === name);
        expect(tool).toBeDefined();
        return tool!;
      };

      const contextTool = findTool("queryRegistry__demo_context");
      const listTool = findTool("queryRegistry__demo_queries_list");
      const describeTool = findTool("queryRegistry__demo_query_describe");
      const executeTool = findTool("queryRegistry__demo_query_execute");

      const contextResult = await contextTool.execute("ctx-1", {}, undefined, undefined);
      await expectTextContentBlock(
        contextResult.content[0],
        "Domain: finance demo. Fiscal branches: filial A, filial B.",
      );

      const listResult = await listTool.execute("list-1", {}, undefined, undefined);
      await expectTextContentBlock(
        listResult.content[0],
        JSON.stringify([
          { queryId: "AUD004", required: ["filial", "data"] },
          { queryId: "CAD005", required: ["termo"] },
        ]),
      );

      const describeResult = await describeTool.execute(
        "describe-1",
        { queryId: "AUD004" },
        undefined,
        undefined,
      );
      await expectTextContentBlock(
        describeResult.content[0],
        JSON.stringify({
          type: "object",
          properties: { filial: { type: "string" }, data: { type: "string" } },
          required: ["filial", "data"],
        }),
      );

      const executeResult = await executeTool.execute(
        "execute-1",
        { queryId: "AUD004", params: { filial: "A", data: "2026-07-01" } },
        undefined,
        undefined,
      );
      await expectTextContentBlock(
        executeResult.content[0],
        JSON.stringify({
          result: "AUD004 snapshot",
          filial: "A",
          data: "2026-07-01",
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects execute when the query has not been described", async () => {
    const { serverPath } = await makeTempFixture(tempDirs);
    const sessionKey = `agent:test:query-registry:${sessionSeq++}`;
    const runtime = await createQueryRegistryRuntime({ serverPath, sessionKey });

    try {
      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      const executeTool = materialized.tools.find(
        (t) => t.name === "queryRegistry__demo_query_execute",
      )!;

      const result = await executeTool.execute(
        "execute-undescribed",
        { queryId: "AUD004", params: { filial: "A", data: "2026-07-01" } },
        undefined,
        undefined,
      );

      // MCP errors are surfaced in result.details.status, not as a top-level
      // isError field. The fixture returns isError=true; the materializer maps it
      // to details.status === "error" so agent code can react consistently.
      expect(result.details).toMatchObject({ status: "error" });
      await expectTextContentBlock(
        result.content[0],
        "Query AUD004 must be described before execute.",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects execute with missing params", async () => {
    const { serverPath } = await makeTempFixture(tempDirs);
    const sessionKey = `agent:test:query-registry:${sessionSeq++}`;
    const runtime = await createQueryRegistryRuntime({ serverPath, sessionKey });

    try {
      // Describe first so the error is specifically about params, not ordering.
      await runtime.callTool("queryRegistry", "demo_query_describe", { queryId: "AUD004" });
      const result = await runtime.callTool("queryRegistry", "demo_query_execute", {
        queryId: "AUD004",
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text?: string }).text ?? "";
      expect(text).toMatch(/params/);
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects describe for an unknown query id", async () => {
    const { serverPath } = await makeTempFixture(tempDirs);
    const sessionKey = `agent:test:query-registry:${sessionSeq++}`;
    const runtime = await createQueryRegistryRuntime({ serverPath, sessionKey });

    try {
      const result = await runtime.callTool("queryRegistry", "demo_query_describe", {
        queryId: "NOPE999",
      });

      expect(result.isError).toBe(true);
      await expectTextContentBlock(result.content[0], "Unknown query id: NOPE999");
    } finally {
      await runtime.dispose();
    }
  });
});
