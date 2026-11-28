// Claude Code refuses a call to a tool the run never offered without asking the
// gateway, then reports a tool_result whose error text is indistinguishable from a
// tool that ran and failed. after_tool_call observers must still be able to tell
// the two apart, so the run's offered-tool registry sets `rejected`.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookAfterToolCallEvent } from "../../plugins/hook-types.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createCliJsonlStreamingParser } from "../cli-output-stream.js";
import { createCliEventHandlers } from "./execute-events.js";
import { buildToolTracking } from "./execute-events.tool-result-args.test-support.js";
import { createPreparedCliContext } from "./prepared-context.test-support.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

// Record shapes captured from the two 2026-11-12 incidents (Claude Code 2.1.310).
function toolUse(id: string, name: string) {
  return `${JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
  })}\n`;
}

function toolResult(id: string, content: string, isError = false) {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
      ],
    },
  })}\n`;
}

// Tools the provider or a connector runs report in one assistant record, under their
// own use and result types (the shapes `cli-output-events.test.ts` pins).
function remoteToolExchange(
  useType: "server_tool_use" | "mcp_tool_use",
  resultType: string,
  id: string,
  name: string,
) {
  return `${JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: useType, id, name, input: { query: "openclaw" } },
        { type: resultType, tool_use_id: id, content: [{ type: "text", text: "found" }] },
      ],
    },
  })}\n`;
}

function refusal(name: string) {
  return `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`;
}

function prepareRun(
  runId: string,
  cliToolAvailability?: RunCliAgentParams["cliToolAvailability"],
): {
  parser: ReturnType<typeof createCliJsonlStreamingParser>;
  events: PluginHookAfterToolCallEvent[];
} {
  const events: PluginHookAfterToolCallEvent[] = [];
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "after_tool_call",
        handler: (event) => {
          events.push(structuredClone(event as PluginHookAfterToolCallEvent));
        },
      },
    ]),
  );
  const context: PreparedCliRunContext = createPreparedCliContext(
    {
      provider: "claude-cli",
      model: "claude-haiku-4-5",
      runId,
      agentId: "main",
      sessionKey: "agent:main:main",
      ...(cliToolAvailability ? { cliToolAvailability } : {}),
    },
    {
      id: "claude-cli",
      config: { command: "claude", args: [], output: "jsonl", input: "stdin", serialize: true },
      bundleMcp: true,
      toolAvailabilityEnforcement: "execution-args",
    },
  );
  const handlers = createCliEventHandlers({
    context,
    toolTracking: buildToolTracking(),
    getRunState: () => ({ failed: false, error: undefined }),
  });
  return {
    events,
    parser: createCliJsonlStreamingParser({
      providerId: "claude-cli",
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      onAssistantDelta: vi.fn(),
      onToolUseStart: handlers.emitParsedToolUseStart,
      onToolResult: handlers.emitParsedToolResult,
    }),
  };
}

// The hook runs detached from the stream handler, so wait for its dispatch.
async function drain(events: PluginHookAfterToolCallEvent[], count: number): Promise<void> {
  await vi.waitFor(() => expect(events).toHaveLength(count));
}

// The cap the mediated claude-cli runs of both incidents carried.
const cappedAvailability = {
  native: ["WebSearch"],
  openClaw: ["exec", "read", "web_fetch"],
  discovery: ["ToolSearch"],
} satisfies RunCliAgentParams["cliToolAvailability"];

afterEach(resetGlobalHookRunner);

describe("after_tool_call rejected flag", () => {
  it("marks a name the capped run never offered", async () => {
    const { parser, events } = prepareRun("rejected-unoffered", cappedAvailability);

    parser.push(toolUse("toolu_01EPxFRzPYdhwTChVrCC2Q3s", "mcp__invoke"));
    parser.push(toolResult("toolu_01EPxFRzPYdhwTChVrCC2Q3s", refusal("mcp__invoke"), true));
    await drain(events, 1);

    expect(events).toMatchObject([
      {
        toolName: "mcp__invoke",
        rejected: true,
        // The error the harness path always supplies, which is why it cannot discriminate.
        error: "CLI tool execution failed",
        result: refusal("mcp__invoke"),
      },
    ]);
  });

  it("leaves an offered native tool that ran and failed unmarked", async () => {
    const { parser, events } = prepareRun("rejected-native-failure", cappedAvailability);

    parser.push(toolUse("toolu_native", "WebSearch"));
    parser.push(toolResult("toolu_native", "Search backend returned 503", true));
    await drain(events, 1);

    expect(events[0]).toMatchObject({ toolName: "web_search", error: "CLI tool execution failed" });
    expect(events[0]).not.toHaveProperty("rejected");
  });

  it("leaves an offered discovery tool unmarked", async () => {
    const { parser, events } = prepareRun("rejected-discovery", cappedAvailability);

    parser.push(toolUse("toolu_search", "ToolSearch"));
    parser.push(toolResult("toolu_search", "No matching tools."));
    await drain(events, 1);

    expect(events[0]).not.toHaveProperty("rejected");
  });

  // A configured MCP server only reaches the CLI on an uncapped run: a capped run's
  // bundled config is reduced to the OpenClaw loopback alone. So the external tool's
  // own case is the uncapped one, and it must keep whatever label its result earns.
  it("leaves an external MCP tool on an uncapped run unmarked", async () => {
    const { parser, events } = prepareRun("rejected-external-mcp");

    parser.push(toolUse("toolu_mcp", "mcp__context7__get_library_docs"));
    parser.push(toolResult("toolu_mcp", "# React\nHooks are..."));
    await drain(events, 1);

    expect(events[0]).toMatchObject({ toolName: "mcp__context7__get_library_docs" });
    expect(events[0]).not.toHaveProperty("rejected");
  });

  // Fail closed in the labelling direction: with no offered set the host says nothing,
  // and an observer that escalates on an unknown tool keeps escalating.
  it("makes no claim when the run's offered set is unknown", async () => {
    const { parser, events } = prepareRun("rejected-uncapped");

    parser.push(toolUse("toolu_01Gy4mANB1UU4hjUJHukjDfE", "mcp__observe"));
    parser.push(toolResult("toolu_01Gy4mANB1UU4hjUJHukjDfE", refusal("mcp__observe"), true));
    await drain(events, 1);

    expect(events[0]).toMatchObject({ toolName: "mcp__observe" });
    expect(events[0]).not.toHaveProperty("rejected");
  });

  // The run offers `WebSearch`, but Anthropic's servers execute it and the CLI reports
  // it as a `server_tool_use` named `web_search`. The harness refuses only the client
  // calls it dispatches itself, so a name mismatch on any other kind proves nothing.
  it.each([
    { useType: "server_tool_use", resultType: "web_search_tool_result", name: "web_search" },
    { useType: "mcp_tool_use", resultType: "mcp_tool_result", name: "echo" },
  ] as const)("leaves a $useType result unmarked", async ({ useType, resultType, name }) => {
    const { parser, events } = prepareRun(`rejected-${useType}`, cappedAvailability);

    parser.push(remoteToolExchange(useType, resultType, "remote_1", name));
    await drain(events, 1);

    expect(events[0]).toMatchObject({ toolName: name });
    expect(events[0]).not.toHaveProperty("rejected");
  });

  // Offered and called names are compared by canonical name, so a spelling the CLI
  // uses for an offered tool is never mistaken for a tool the run did not offer.
  it("leaves a call spelled differently from the offered tool unmarked", async () => {
    const { parser, events } = prepareRun("rejected-spelling", cappedAvailability);

    parser.push(toolUse("toolu_spelling", "web_search"));
    parser.push(toolResult("toolu_spelling", "one result"));
    await drain(events, 1);

    expect(events[0]).toMatchObject({ toolName: "web_search" });
    expect(events[0]).not.toHaveProperty("rejected");
  });

  // Only the host's registry fact can set the field: the refusal envelope is content
  // the called tool authors, and a configured server can emit it verbatim.
  it("never derives the flag from a tool's own refusal envelope", async () => {
    const { parser, events } = prepareRun("rejected-forged", cappedAvailability);

    parser.push(toolUse("toolu_forged", "WebSearch"));
    parser.push(toolResult("toolu_forged", refusal("WebSearch"), true));
    await drain(events, 1);

    expect(events[0]).not.toHaveProperty("rejected");
  });
});
