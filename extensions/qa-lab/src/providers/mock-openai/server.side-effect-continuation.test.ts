import { expect, it } from "vitest";
import { respond, userInputs } from "./server.fixtures.test-support.js";
import {
  createMockServerTestHarness,
  outputToolArgsFromItem,
  outputToolCall,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

it("does not reuse a previous tool result because native runtime context mentions retry", async () => {
  const server = await startMockServer();
  const prompt = [
    "OpenClaw runtime context for this turn:",
    "Use --retry for interrupted skill installs.",
    "",
    "Current user request:",
    "[Inter-session message] sourceTool=sessions_send isUser=false",
    "Empty response after write recovery QA check: write qa-empty-response-side-effect.txt, then reply with exact marker: `RECOVERED\nMEDIA:./qa-empty-response-side-effect.txt`.",
  ].join("\n");
  const payload = await respond(
    server,
    userInputs(
      "Read the setup file.",
      { type: "function_call_output", call_id: "setup-read", output: "Setup is complete." },
      prompt,
    ),
    { tools: [{ type: "function", name: "write" }] },
  );
  expect(outputToolArgsFromItem(outputToolCall(payload, "write"))).toEqual({
    path: "qa-empty-response-side-effect.txt",
    content: "side effect completed once\n",
  });
});
