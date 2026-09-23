import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolCall, type Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createAppleFmNative } from "./native.js";
import { createAppleFmStream } from "./stream.js";

const live =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.platform === "darwin" &&
  process.arch === "arm64";

it.runIf(live)(
  "generates literal tool arguments natively and resumes the exact tool result",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "apple-fm-live-"));
    const native = createAppleFmNative(fileURLToPath(new URL(".", import.meta.url)));
    const options = { env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
    const tool = {
      name: "setup",
      description: "Open the requested channel setup form.",
      parameters: Type.Object({
        action: Type.Literal("connect_channel"),
        channel: Type.Literal("telegram"),
        ids: Type.Array(Type.String({ minLength: 1, maxLength: 20 }), {
          minItems: 1,
          maxItems: 1,
        }),
        sha256: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{64}$" })),
      }),
    };
    const user = {
      role: "user",
      content: 'Use the setup tool to connect Telegram with ids ["primary"].',
    };
    try {
      const detected = await native.probe(options);
      expect(detected?.available).toBe(true);
      expect(detected?.contextWindow).toBeGreaterThanOrEqual(8192);
      expect(await fs.readdir(directory)).toEqual([]);
      await expect(native.run({ messages: [user] }, options)).rejects.toThrow("setup again");
      const facts = await native.prepare(options);
      expect(facts.available).toBe(true);
      expect(facts.contextWindow).toBeGreaterThanOrEqual(8192);
      const request = {
        systemPrompt:
          "Call setup to connect a channel. Only report a completed setup when the tool result confirms it.",
        messages: [user],
        tools: [tool],
        maxTokens: 256,
        temperature: 0,
      };
      const first = await native.run(request, options);
      expect(first.toolCalls).toHaveLength(1);
      const call = first.toolCalls[0];
      if (!call) {
        throw new Error("Native model did not call the setup tool");
      }
      expect(call).toMatchObject({
        name: "setup",
        arguments: { action: "connect_channel", channel: "telegram", ids: ["primary"] },
      });
      expect(validateToolCall([tool], { type: "toolCall", ...call })).toEqual(call.arguments);
      expect(() =>
        validateToolCall([tool], {
          type: "toolCall",
          ...call,
          arguments: { ...call.arguments, sha256: "invalid" },
        }),
      ).toThrow();
      expect(() =>
        validateToolCall([tool], {
          type: "toolCall",
          ...call,
          arguments: { ...call.arguments, ids: [""] },
        }),
      ).toThrow();
      const second = await native.run(
        {
          ...request,
          messages: [
            user,
            { role: "assistant", content: [{ type: "toolCall", ...call }] },
            {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              isError: false,
              content: [
                {
                  type: "text",
                  text: "The Telegram setup form is ready. Ask the user to continue in that form. No configuration has been changed.",
                },
              ],
            },
          ],
        },
        options,
      );
      expect(second.toolCalls).toEqual([]);
      expect(second.text.toLowerCase()).toContain("form");
      expect(second.inputTokens).toBeGreaterThan(first.inputTokens);
      const model: Model<"openai-completions"> = {
        id: "system",
        name: facts.modelName,
        provider: "apple-fm",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1",
        contextWindow: facts.contextWindow,
        maxTokens: 256,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const stream = createAppleFmStream({
        run: (nativeRequest, runOptions) =>
          native.run(nativeRequest, { ...options, ...runOptions }),
      });
      const responseFormat = {
        type: "object",
        properties: {
          status: {
            anyOf: [{ type: "string", minLength: 5, maxLength: 5 }, { type: "null" }],
          },
          note: { type: "string", default: "unused" },
        },
        required: ["status"],
      };
      for (const [prompt, status] of [
        ["Report the status ready. Omit note.", "ready"],
        ["Report the missing status as null. Omit note.", null],
      ] as const) {
        const structured = await stream(
          model,
          { messages: [{ role: "user", content: prompt, timestamp: 0 }] },
          { maxTokens: 64, temperature: 0, responseFormat },
        );
        const result = await structured.result();
        expect(result.stopReason, result.errorMessage).toBe("stop");
        const text = result.content.find((block) => block.type === "text");
        expect(text?.type).toBe("text");
        if (text?.type === "text") {
          expect(JSON.parse(text.text)).toEqual({ status });
        }
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
