import {
  createAgentToolResultMiddlewareRunner,
  type AgentToolResultMiddlewareEvent,
} from "openclaw/plugin-sdk/agent-harness";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearRuleCache } from "tokenjuice";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

beforeAll(() => {
  vi.stubEnv("TOKENJUICE_STATS", "0");
  vi.stubEnv("TOKENJUICE_NO_OMISSION", "1");
});
afterAll(() => {
  clearRuleCache();
  vi.unstubAllEnvs();
});

it("runs the packaged reducer while preserving exact reads and Code Mode results", async () => {
  const captured = capturePluginRegistration({
    id: "tokenjuice",
    contracts: manifest.contracts,
    register: plugin.register,
  });
  const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
    captured.agentToolResultMiddlewares[0]!.handler,
  ]);
  const raw = [
    "On branch feature/fixture",
    "",
    "Changes not staged for commit:",
    "\tmodified:   src/alpha.ts",
    "\tmodified:   src/beta.ts",
    "",
    "no changes added to commit",
    "",
    "",
  ].join("\r\n");
  const event = (command: string): AgentToolResultMiddlewareEvent => ({
    toolCallId: "tokenjuice-package-smoke",
    toolName: "exec",
    args: { command, workdir: "/workspace/tokenjuice" },
    result: {
      content: [{ type: "text", text: raw }],
      details: {
        status: "completed",
        exitCode: 0,
        aggregated: raw,
        fullOutputPath: "/workspace/tokenjuice/full-output.txt",
      },
    },
    isError: false,
  });
  const compacted = await runner.applyToolResultMiddleware(event("git status"));
  expect(compacted.content).toEqual([
    {
      type: "text",
      text: "Changes not staged:\nM: src/alpha.ts\nM: src/beta.ts\n\n[tokenjuice compacted bash output]",
    },
  ]);
  expect(compacted.details).toMatchObject({
    status: "completed",
    exitCode: 0,
    aggregated:
      "Changes not staged:\nM: src/alpha.ts\nM: src/beta.ts\n\n[tokenjuice compacted bash output]",
    fullOutputPath: "/workspace/tokenjuice/full-output.txt",
    tokenjuice: { compacted: true },
  });
  const exactRead = event("cat README.md");
  expect(await runner.applyToolResultMiddleware(exactRead)).toEqual(exactRead.result);

  const code = 'return { records: await catalog.search("schema") };';
  const codeMode = event(code);
  codeMode.args.code = code;
  const text = JSON.stringify(
    { records: Array.from({ length: 250 }, (_, id) => ({ id, value: `record-${id}` })) },
    null,
    2,
  );
  codeMode.result = {
    content: [{ type: "text", text }],
    details: { status: "completed", exitCode: 0, aggregated: text },
  };
  const expected = structuredClone(codeMode.result);
  expect(await runner.applyToolResultMiddleware(codeMode)).toEqual(expected);
});
