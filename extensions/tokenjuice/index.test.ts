import {
  createAgentToolResultMiddlewareRunner,
  type AgentToolResultMiddlewareEvent,
  type OpenClawAgentToolResult,
} from "openclaw/plugin-sdk/agent-harness";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toolResultHandler } = vi.hoisted(() => ({
  toolResultHandler:
    vi.fn<
      (event: {
        toolName: string;
        details: Record<string, unknown>;
      }) => Promise<Partial<OpenClawAgentToolResult> | void>
    >(),
}));
// mock-isolation: Exercise the real middleware without loading external TokenJuice reducers.
vi.mock("./runtime-api.js", () => ({
  createTokenjuiceOpenClawEmbeddedExtension:
    () => (api: { on: (event: string, handler: unknown) => void }) =>
      api.on("tool_result", toolResultHandler),
}));
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { createTokenjuiceAgentToolResultMiddleware } from "./tool-result-middleware.js";

function compacted(): OpenClawAgentToolResult["content"] {
  return [{ type: "text", text: "compacted" }];
}
const completed = { status: "completed", exitCode: 0 };
function toolEvent(
  toolName: string,
  details: unknown,
  text = "file contents\n",
): AgentToolResultMiddlewareEvent {
  return {
    toolCallId: "tool-call-tokenjuice",
    toolName,
    args: { command: "cat /tmp/out.txt", workdir: "/tmp/openclaw-tokenjuice-test" },
    result: { content: [{ type: "text", text }], details },
    isError: false,
  };
}
async function applyBashResult(details: unknown) {
  const result = await createTokenjuiceAgentToolResultMiddleware()(toolEvent("bash", details), {
    runtime: "openclaw",
  });
  return { received: toolResultHandler.mock.calls[0]?.[0], result };
}

describe("tokenjuice plugin", () => {
  beforeEach(() => toolResultHandler.mockReset().mockResolvedValue(undefined));
  it("registers tokenjuice tool result middleware for OpenClaw, Codex, and Agents API runtimes", async () => {
    const captured = capturePluginRegistration({
      id: "tokenjuice",
      contracts: manifest.contracts,
      register: plugin.register,
    });
    const registration = captured.agentToolResultMiddlewares[0];
    expect(typeof registration?.handler).toBe("function");
    expect(registration?.runtimes).toEqual(["openclaw", "codex", "agentsapi"]);
    toolResultHandler.mockResolvedValueOnce({ content: compacted() });
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      registration!.handler,
    ]);
    const result = await runner.applyToolResultMiddleware(toolEvent("exec", completed));
    expect(result.content).toEqual(compacted());
  });

  it("passes through status metadata without duplicate aggregated output", async () => {
    const metadata = { ...completed, cwd: "/existing/cwd" };
    const existingDetails = { ...metadata, aggregated: "pre-built output" };
    const { received } = await applyBashResult(existingDetails);
    expect(received?.details).toEqual(metadata);
    expect(received?.details).not.toBe(existingDetails);
  });

  it("keeps compacted exec results below the middleware details limit", async () => {
    toolResultHandler.mockImplementationOnce(async (event) => ({
      content: compacted(),
      details: { ...event.details, tokenjuice: { compacted: true } },
    }));
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      createTokenjuiceAgentToolResultMiddleware(),
    ]);
    const result = await runner.applyToolResultMiddleware(
      toolEvent("exec", undefined, "x".repeat(120_000)),
    );
    expect(result.content).toEqual(compacted());
    expect(result.details).toEqual({ ...completed, tokenjuice: { compacted: true } });
  });

  it.each([
    ["error value", { error: "command failed" }, "failed", 1],
    ["successful exit code", { exitCode: 0 }, "completed", 0],
  ])(
    "adds a canonical status while preserving bash details with a %s",
    async (_label, existingDetails, status, exitCode) => {
      const { received } = await applyBashResult(existingDetails);
      expect(received?.details).toMatchObject({ ...existingDetails, status, exitCode });
    },
  );

  it("normalizes bash results without details before passing them to tokenjuice", async () => {
    toolResultHandler.mockResolvedValueOnce({ content: compacted() });
    const { received, result } = await applyBashResult(undefined);
    expect(received?.toolName).toBe("bash");
    expect(received?.details).toEqual(completed);
    expect(result?.result.content).toEqual(compacted());
  });
});
