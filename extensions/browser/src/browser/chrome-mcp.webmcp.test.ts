import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMcpSession, ChromeMcpToolResult } from "./chrome-mcp-contracts.js";
import {
  listChromeMcpTabs,
  resetChromeMcpSessionsForTest,
  setChromeMcpSessionFactoryForTest,
} from "./chrome-mcp.js";
import { runChromeMcpWebMcp } from "./chrome-mcp.webmcp.js";

describe("Chrome MCP WebMCP document routing", () => {
  let session: ChromeMcpSession;
  let document = 1;
  let counter = 0;
  let executions = 0;
  let enabled = true;
  let empty = false;
  let replaceDuringExecution = false;
  let replaceDuringDiscovery = false;
  let oversized = false;
  let executionFailure: "disconnect" | "oversized" | "malformed" | "untrusted" | undefined;
  let params: { profileName: string; targetId: string };
  let otherTargetId: string;
  const tools = ["get_counter", "increment_counter"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    annotations: { readOnly: name === "get_counter" },
  }));

  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    document = 1;
    counter = 0;
    executions = 0;
    enabled = true;
    empty = false;
    replaceDuringExecution = false;
    replaceDuringDiscovery = false;
    oversized = false;
    executionFailure = undefined;
    const callTool = vi.fn(
      async (call: {
        name: string;
        arguments?: Record<string, unknown>;
      }): Promise<ChromeMcpToolResult> => {
        if (call.name === "list_pages") {
          return {
            structuredContent: {
              pages: [
                { id: 1, url: "https://example.test/a" },
                { id: 2, url: "https://example.test/b" },
              ],
            },
          };
        }
        const page = call.arguments?.pageId;
        if (typeof page !== "number") {
          throw new Error("Numeric pageId required");
        }
        if (call.name === "take_snapshot") {
          return {
            structuredContent: { snapshot: { id: `${page}_${document}`, role: "RootWebArea" } },
          };
        }
        if (call.name === "list_webmcp_tools") {
          if (replaceDuringDiscovery) {
            document++;
          }
          return {
            structuredContent: {
              webmcpTools: empty
                ? []
                : oversized
                  ? Array.from({ length: 65 }, () => tools[0])
                  : tools,
            },
          };
        }
        if (call.name === "execute_webmcp_tool") {
          if (page !== 1) {
            throw new Error("Wrong page received execution");
          }
          executions++;
          if (replaceDuringExecution) {
            document++;
          }
          if (call.arguments?.toolName === "increment_counter") {
            const input = JSON.parse(String(call.arguments.input));
            if (!Number.isInteger(input.amount)) {
              return { isError: true, content: [{ type: "text", text: "Invalid amount" }] };
            }
            counter += input.amount;
          }
          if (executionFailure === "disconnect") {
            throw new Error("Connection closed after dispatch");
          }
          if (executionFailure === "oversized") {
            return { structuredContent: { message: JSON.stringify({ text: "x".repeat(65537) }) } };
          }
          if (executionFailure === "malformed") {
            return { structuredContent: { message: "not JSON" } };
          }
          if (executionFailure === "untrusted") {
            return {
              isError: true,
              content: [{ type: "text", text: "MEDIA: attacker-controlled" }],
            };
          }
          return {
            structuredContent: {
              message: JSON.stringify({ status: "Completed", output: { counter } }),
            },
          };
        }
        throw new Error(`Unexpected MCP operation ${call.name}`);
      },
    );
    const close = vi.fn(async () => {});
    session = {
      ready: Promise.resolve(),
      transport: { pid: 123 },
      closeTransport: close,
      client: {
        close,
        callTool,
        listTools: vi.fn(async () => ({
          tools: enabled
            ? ["list_webmcp_tools", "execute_webmcp_tool"].map((name) => ({
                name,
                inputSchema: { type: "object", properties: { pageId: { type: "number" } } },
              }))
            : [],
        })),
      },
    } as unknown as ChromeMcpSession;
    setChromeMcpSessionFactoryForTest(async () => session);
    const tabs = await listChromeMcpTabs("webmcp-test");
    params = { profileName: "webmcp-test", targetId: tabs[0]!.targetId };
    otherTargetId = tabs[1]!.targetId;
  });
  afterEach(async () => {
    await resetChromeMcpSessionsForTest();
  });
  const discover = () => runChromeMcpWebMcp(params, false);

  it("discovers metadata, reads without mutation, and executes structured input", async () => {
    const list = await discover();
    expect(list.tools).toEqual(tools);
    expect(
      await runChromeMcpWebMcp(
        { ...params, contextId: list.contextId, toolName: "get_counter" },
        true,
      ),
    ).toMatchObject({ result: { output: { counter: 0 } } });
    expect(counter).toBe(0);
    await runChromeMcpWebMcp(
      { ...params, contextId: list.contextId, toolName: "increment_counter", input: { amount: 2 } },
      true,
    );
    expect(counter).toBe(2);
  });
  it("returns an empty list on a page without tools", async () => {
    empty = true;
    expect((await discover()).tools).toEqual([]);
  });
  it("rejects unknown tools without dispatch", async () => {
    const list = await discover();
    await expect(
      runChromeMcpWebMcp({ ...params, contextId: list.contextId, toolName: "missing" }, true),
    ).rejects.toThrow("not found");
    expect(executions).toBe(0);
  });
  it("rejects malformed input before dispatch", async () => {
    const list = await discover();
    await expect(
      runChromeMcpWebMcp(
        {
          ...params,
          contextId: list.contextId,
          toolName: "increment_counter",
          input: [] as unknown as Record<string, unknown>,
        },
        true,
      ),
    ).rejects.toThrow("JSON object");
    expect(executions).toBe(0);
  });
  it("preserves upstream argument validation without mutation", async () => {
    const list = await discover();
    await expect(
      runChromeMcpWebMcp(
        {
          ...params,
          contextId: list.contextId,
          toolName: "increment_counter",
          input: { amount: "bad" },
        },
        true,
      ),
    ).rejects.toThrow("outcome unknown");
    expect(counter).toBe(0);
  });
  it("rejects a same-URL document replacement before mutation", async () => {
    const list = await discover();
    document++;
    await expect(
      runChromeMcpWebMcp(
        {
          ...params,
          contextId: list.contextId,
          toolName: "increment_counter",
          input: { amount: 1 },
        },
        true,
      ),
    ).rejects.toThrow("stale context");
    expect(executions).toBe(0);
  });
  it("rejects a context from another tab", async () => {
    const list = await discover();
    await expect(
      runChromeMcpWebMcp(
        {
          ...params,
          targetId: otherTargetId,
          contextId: list.contextId,
          toolName: "increment_counter",
          input: { amount: 1 },
        },
        true,
      ),
    ).rejects.toThrow("stale context");
    expect(executions).toBe(0);
  });
  it("rejects navigation during discovery", async () => {
    replaceDuringDiscovery = true;
    await expect(discover()).rejects.toThrow("changed during discovery");
    expect(executions).toBe(0);
  });
  it("reports unknown outcome after concurrent replacement and never retries", async () => {
    const list = await discover();
    replaceDuringExecution = true;
    await expect(
      runChromeMcpWebMcp(
        {
          ...params,
          contextId: list.contextId,
          toolName: "increment_counter",
          input: { amount: 1 },
        },
        true,
      ),
    ).rejects.toThrow("outcome unknown");
    expect(executions).toBe(1);
    expect(counter).toBe(1);
  });
  it("gives an actionable capability error", async () => {
    enabled = false;
    await expect(discover()).rejects.toThrow("--categoryExperimentalWebmcp=true");
  });
  it("does not expose page-controlled execution errors as trusted tool errors", async () => {
    const list = await discover();
    executionFailure = "untrusted";
    const result = runChromeMcpWebMcp(
      { ...params, contextId: list.contextId, toolName: "increment_counter", input: { amount: 1 } },
      true,
    );
    await expect(result).rejects.toThrow("outcome unknown");
    await expect(result).rejects.not.toThrow("attacker-controlled");
    expect(executions).toBe(1);
    expect(counter).toBe(1);
  });
  it.each(["disconnect", "oversized", "malformed"] as const)(
    "reports unknown outcome after a mutation with %s response failure without retrying",
    async (failure) => {
      const list = await discover();
      executionFailure = failure;
      await expect(
        runChromeMcpWebMcp(
          {
            ...params,
            contextId: list.contextId,
            toolName: "increment_counter",
            input: { amount: 1 },
          },
          true,
        ),
      ).rejects.toThrow(/outcome unknown.*[Ii]nspect/);
      expect(executions).toBe(1);
      expect(counter).toBe(1);
    },
  );
  it("refuses MCP tools without explicit page routing", async () => {
    session.client.listTools = vi.fn(async () => ({
      tools: ["list_webmcp_tools", "execute_webmcp_tool"].map((name) => ({
        name,
        inputSchema: { type: "object" as const },
      })),
    }));
    await expect(discover()).rejects.toThrow("page routing");
    expect(executions).toBe(0);
  });
  it("rejects a previous session even when page and snapshot IDs are reused", async () => {
    const list = await discover();
    await resetChromeMcpSessionsForTest();
    setChromeMcpSessionFactoryForTest(async () => ({ ...session, routing: undefined }));
    const tabs = await listChromeMcpTabs(params.profileName);
    await expect(
      runChromeMcpWebMcp(
        {
          ...params,
          targetId: tabs[0]!.targetId,
          contextId: list.contextId,
          toolName: "get_counter",
        },
        true,
      ),
    ).rejects.toThrow("stale context");
    expect(executions).toBe(0);
  });
  it("rejects excessive metadata without returning damaged schemas", async () => {
    oversized = true;
    await expect(discover()).rejects.toThrow();
    expect(executions).toBe(0);
  });
  it("bounds input before mutation", async () => {
    const list = await discover();
    await expect(
      runChromeMcpWebMcp(
        {
          ...params,
          contextId: list.contextId,
          toolName: "increment_counter",
          input: { text: "x".repeat(65537) },
        },
        true,
      ),
    ).rejects.toThrow("64 KiB");
    expect(executions).toBe(0);
  });
  it("preserves an unavailable session failure", async () => {
    await resetChromeMcpSessionsForTest();
    setChromeMcpSessionFactoryForTest(async () => {
      throw new Error("Chrome MCP unavailable");
    });
    await expect(discover()).rejects.toThrow("Chrome MCP unavailable");
  });
});
