import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupRuntimeToolFixtureTempRoots,
  makeEnv,
  runLiveRuntimeToolFixture,
  runtimeToolFixtureConfig,
  transcriptToolCall,
  transcriptToolResult,
  writeRuntimeToolTranscripts,
} from "../test/runtime-tool-fixture-helpers.js";

afterEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
});
afterAll(cleanupRuntimeToolFixtureTempRoots);

describe("runtime tool fixture transcript evidence", () => {
  it("requires live runtime tool fixtures to produce transcript tool output", async () => {
    const env = await makeEnv();
    await writeRuntimeToolTranscripts(
      env,
      "read",
      [{ role: "assistant", content: "I checked README.md and it looks good." }],
      [{ role: "assistant", content: "The denied-input path looks good." }],
    );

    await expect(runLiveRuntimeToolFixture(env)).rejects.toThrow(
      "expected live happy-path tool call for read",
    );
  });

  it.each([
    {
      name: "Code Mode control output without a physical exec",
      happyMessages: [
        transcriptToolCall("exec", "happy", { code: 'return "done";' }),
        transcriptToolResult("exec", "happy", "done"),
      ],
      expectedError: "expected live happy-path tool call for exec",
    },
    {
      name: "native cell wait control output",
      toolName: "wait",
      happyMessages: [
        transcriptToolCall("exec", "happy", { input: 'await Promise.resolve("done");' }),
        transcriptToolResult(
          "exec",
          "happy",
          "Script running with cell ID native-cell\nWall time 0.01 seconds\nOutput:\n",
        ),
        transcriptToolCall("wait", "happy", {
          arguments: JSON.stringify({ cell_id: "native-cell" }),
        }),
        transcriptToolResult("wait", "happy", "done"),
      ],
      expectedError: "expected live happy-path tool call for wait",
    },
    {
      name: "an exec result that precedes its call",
      happyMessages: [
        transcriptToolResult("exec", "happy", "done"),
        transcriptToolCall("exec", "happy", { command: "proof" }),
      ],
      expectedError: "expected live happy-path tool output for exec",
    },
    {
      name: "a nonzero physical exit despite isError=false",
      happyMessages: [
        transcriptToolCall("exec", "happy", { command: "proof" }),
        {
          ...transcriptToolResult("exec", "happy", "process completed", false),
          details: { status: "completed", exitCode: 1 },
        },
      ],
      expectedError: "expected live happy-path successful tool output for exec",
    },
  ])(
    "rejects $name as runtime execution proof",
    async ({ happyMessages, expectedError, toolName = "exec" }) => {
      const env = await makeEnv();
      await writeRuntimeToolTranscripts(env, toolName, happyMessages, [
        transcriptToolCall(toolName, "failure", { command: "denied" }),
        transcriptToolResult(toolName, "failure", "permission denied", true),
      ]);

      await expect(runLiveRuntimeToolFixture(env, { toolName })).rejects.toThrow(expectedError);
    },
  );

  it.each([false, true])(
    "links provider function calls to nameless results without rewriting arguments (block fallback: %s)",
    async (blockFallback) => {
      const env = await makeEnv();
      const happyArgs = '{"path":"README.md"}';
      await writeRuntimeToolTranscripts(
        env,
        "read",
        [
          {
            role: "assistant",
            tool_calls: [
              { id: "provider-happy", function: { name: "read", arguments: happyArgs } },
            ],
          },
          {
            role: "tool",
            tool_call_id: "provider-happy",
            content: blockFallback
              ? [{ message: "README contents", error: "permission denied" }]
              : "README contents",
          },
        ],
        [
          {
            role: "assistant",
            function_call: {
              id: "provider-failure",
              name: "read",
              arguments: '{"path":"/missing"}',
            },
          },
          blockFallback
            ? {
                role: "tool",
                tool_call_id: "provider-failure",
                content: [{ error: "permission denied" }],
              }
            : {
                role: "user",
                content: [
                  { type: "tool_result_error", tool_use_id: "provider-failure", content: "denied" },
                ],
              },
        ],
      );

      await expect(runLiveRuntimeToolFixture(env)).resolves.toContain(JSON.stringify(happyArgs));
    },
  );

  it("skips async live runtime tool fixtures when the happy path has no result", async () => {
    const env = await makeEnv();
    await writeRuntimeToolTranscripts(
      env,
      "image_generate",
      [
        transcriptToolCall("image_generate", "happy", {
          prompt: "QA lighthouse runtime parity fixture",
        }),
      ],
      [
        transcriptToolCall("image_generate", "failure", {
          __qaFailureMode: "denied-input",
        }),
        transcriptToolResult("image_generate", "failure", "denied-input", true),
      ],
    );

    await expect(
      runLiveRuntimeToolFixture(env, {
        toolName: "image_generate",
        config: runtimeToolFixtureConfig("image_generate", { happyPathOutputRequired: false }),
      }),
    ).rejects.toThrow("planned call without a linked successful result");
  });

  it("still requires async live runtime tool fixtures to call the happy-path tool", async () => {
    const env = await makeEnv();
    await writeRuntimeToolTranscripts(
      env,
      "image_generate",
      [{ role: "assistant", content: "I can start image generation later." }],
      [
        transcriptToolCall("image_generate", "failure", {
          __qaFailureMode: "denied-input",
        }),
        transcriptToolResult("image_generate", "failure", "denied-input", true),
      ],
    );

    await expect(
      runLiveRuntimeToolFixture(env, {
        toolName: "image_generate",
        config: runtimeToolFixtureConfig("image_generate", { happyPathOutputRequired: false }),
      }),
    ).rejects.toThrow("expected live happy-path tool call for image_generate");
  });

  it("requires live failure fixtures to produce failure-shaped tool output", async () => {
    const env = await makeEnv();
    await writeRuntimeToolTranscripts(
      env,
      "read",
      [
        transcriptToolCall("read", "happy", { path: "README.md" }),
        transcriptToolResult(
          "read",
          "happy",
          "README documents invalid requests, errors, and denied inputs.",
        ),
      ],
      [
        transcriptToolCall("read", "failure", { path: "/missing" }),
        transcriptToolResult("read", "failure", "README contents"),
      ],
    );

    await expect(runLiveRuntimeToolFixture(env)).rejects.toThrow(
      "expected live failure-path tool failure output for read",
    );
  });

  it("rejects failure-shaped live happy-path tool output", async () => {
    const env = await makeEnv();
    await writeRuntimeToolTranscripts(
      env,
      "read",
      [
        transcriptToolCall("read", "happy", { path: "README.md" }),
        transcriptToolResult("read", "happy", "ENOENT: no such file or directory", true),
      ],
      [
        transcriptToolCall("read", "failure", { path: "/missing" }),
        transcriptToolResult("read", "failure", "ENOENT: no such file or directory", true),
      ],
    );

    await expect(runLiveRuntimeToolFixture(env)).rejects.toThrow(
      "expected live happy-path successful tool output for read",
    );
  });
});
