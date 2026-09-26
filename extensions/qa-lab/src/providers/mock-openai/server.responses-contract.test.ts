import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./server.js";
import { guestCodeModeExecTool } from "./server.test-harness.js";

describe("mock Responses contract", () => {
  it.each([undefined, false])("returns a JSON Response when stream is %s", async (stream) => {
    const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qa-model",
          ...(stream === undefined ? {} : { stream }),
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Reply exactly: QA-RESPONSE-CONTRACT" }],
            },
          ],
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "QA-RESPONSE-CONTRACT" }],
          },
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it.each(["mcp code mode qa check", "mcp code mode api file qa check"])(
    "uses the JavaScript-only exec contract for %s",
    async (prompt) => {
      const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
      try {
        const response = await fetch(`${server.baseUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qa-model",
            stream: false,
            input: [{ role: "user", content: prompt }],
            tools: [
              {
                type: "function",
                name: "exec",
                parameters: guestCodeModeExecTool.parameters,
              },
            ],
          }),
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.output[0]).toMatchObject({ type: "function_call", name: "exec" });
        const args = JSON.parse(body.output[0].arguments);
        validateToolArguments(guestCodeModeExecTool, {
          type: "toolCall",
          id: body.output[0].call_id,
          name: "exec",
          arguments: args,
        });
        expect(args).toEqual({ title: expect.any(String), code: expect.any(String) });
      } finally {
        await server.stop();
      }
    },
  );
});
