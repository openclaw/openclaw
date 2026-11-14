import { expect, it } from "vitest";
import type { CodexDynamicToolFunctionSpec } from "./protocol.js";
import { createThreadRequestAttemptParams as createAttemptParams } from "./thread-lifecycle.test-fixtures.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";

it("materializes the openclaw_direct prompt inventory once with matching guidance", () => {
  const params = createAttemptParams({ provider: "openai" });
  params.sourceReplyDeliveryMode = "message_tool_only";
  let namespaceReads = 0;
  const yieldTool: CodexDynamicToolFunctionSpec = {
    type: "function",
    name: "sessions_yield",
    description: "End the current turn",
    inputSchema: { type: "object" },
  };
  const tools = [
    yieldTool,
    ...["zeta_tool", "message", "skill_workshop", "alpha_tool", "sessions_spawn"].map(
      (name): CodexDynamicToolFunctionSpec => ({
        type: "function",
        name,
        description: name,
        inputSchema: { type: "object" },
        deferLoading: ["zeta_tool", "skill_workshop", "alpha_tool"].includes(name),
      }),
    ),
  ];
  const instructions = buildDeveloperInstructions(params, {
    nativeCodeModeEnabled: true,
    dynamicTools: [
      yieldTool,
      {
        type: "namespace",
        name: "openclaw_direct",
        description: "",
        get tools() {
          namespaceReads += 1;
          return tools;
        },
      },
    ],
  });
  expect(namespaceReads).toBe(1);
  expect(instructions.includes("`openclaw_direct.sessions_yield`")).toBe(true);
  expect(instructions.includes("native `wait_agent`")).toBe(true);
  expect(instructions).toContain(
    "Deferred searchable OpenClaw dynamic tools available: openclaw_direct.alpha_tool, openclaw_direct.skill_workshop, openclaw_direct.zeta_tool.",
  );
  expect(instructions).toContain(
    "Use Codex native `spawn_agent` for work that only needs Codex-native tools",
  );
  expect(instructions).toContain(
    "Use `tool_search` for deferred tools when it is directly callable",
  );
  expect(instructions).toContain(
    "Do not repeat a completed call to retrieve a result you already have.",
  );
  expect(instructions).not.toContain("On code-mode-only models");
  expect(instructions).toContain(
    "For new delegated work that needs OpenClaw tools, use `openclaw_direct.sessions_spawn` from the start.",
  );
});
