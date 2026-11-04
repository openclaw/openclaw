import { expect, it } from "vitest";
import {
  type createMockServerTestHarness,
  expectNonStreamingResponsesJson,
  makeUserInput,
  outputItems,
  outputText,
  outputToolCall,
  outputToolCallId,
  makeToolOutputWithCallId,
} from "./server.test-harness.js";

export function registerImageCompletionTests({
  startMockServer,
  tools,
}: {
  startMockServer: ReturnType<typeof createMockServerTestHarness>["startMockServer"];
  tools: readonly [unknown, unknown];
}) {
  const [messageTool, imageGenerateTool] = tools;
  it.each([false, true])(
    "completes an image without replaying it (image tool available: %s)",
    async (imageToolAvailable) => {
      const server = await startMockServer();
      const prompt = "Image generation check: generate a QA lighthouse image.";
      const imagePlan = await expectNonStreamingResponsesJson<unknown>(server, {
        tools: [imageGenerateTool],
        input: [makeUserInput(prompt)],
      });
      const imageCall = outputToolCall(imagePlan, "image_generate");
      const callId = outputToolCallId(imageCall, "call_mock_image_generate_unavailable");
      const completionEvent = [
        "[Inter-session message] sourceChannel=internal sourceTool=image_generate isUser=false",
        "[Internal task completion event]",
        "source: image_generation",
        "task: A QA lighthouse on a dark sea with a tiny protocol droid silhouette.",
        "status: completed successfully",
        "Generated media:",
        "MEDIA:/tmp/qa-lighthouse.png",
      ].join("\n");
      const completionInput = [
        makeUserInput(prompt),
        {
          type: "function_call",
          name: "image_generate",
          call_id: callId,
          arguments: String(imageCall.arguments),
        },
        makeToolOutputWithCallId(
          callId,
          JSON.stringify({
            content: [{ type: "text", text: "Background image generation started." }],
            details: { async: true, status: "started" },
          }),
        ),
        makeUserInput(completionEvent),
      ];
      const completion = await expectNonStreamingResponsesJson<unknown>(server, {
        tools: imageToolAvailable ? [messageTool, imageGenerateTool] : [messageTool],
        input: completionInput,
      });

      expect(
        outputItems(completion).some(
          (item) => item.type === "function_call" && item.name === "image_generate",
        ),
      ).toBe(false);
      expect(outputText(completion)).toBe(
        "Protocol note: generated the QA lighthouse image successfully.\nMEDIA:/tmp/qa-lighthouse.png",
      );
      const nextRequest = await expectNonStreamingResponsesJson<unknown>(server, {
        tools: [imageGenerateTool],
        input: [...completionInput, makeUserInput(prompt)],
      });
      expect(outputToolCall(nextRequest, "image_generate").arguments).toBe(imageCall.arguments);
      const projectedRequest = await expectNonStreamingResponsesJson<unknown>(server, {
        tools: [imageGenerateTool],
        input: [
          makeUserInput(
            `<conversation_context>\n[user]\n${completionEvent}\n</conversation_context>\n\nCurrent user request:\n${prompt}`,
          ),
        ],
      });
      expect(outputToolCall(projectedRequest, "image_generate").arguments).toBe(
        imageCall.arguments,
      );
    },
  );

  it.each([
    { runtime: false, projected: false },
    { runtime: false, projected: true },
    { runtime: true, projected: false },
    { runtime: true, projected: true },
  ])("completes current image events before planning (%j)", async ({ runtime, projected }) => {
    const server = await startMockServer();
    const prompt = "Image generation check: generate a QA lighthouse image.";
    const event = [
      runtime
        ? "[Internal task completion event]"
        : "A background task completed. Use this result to reply to the user.",
      "source: image_generation",
      "status: completed successfully",
      "MEDIA:/tmp/qa-lighthouse.png",
    ].join("\n");
    const continuation = runtime
      ? "[Inter-session message] sourceTool=image_generate\nContinue the OpenClaw runtime event."
      : event;
    const current = projected
      ? `<conversation_context>\n[user]\n${prompt}\n[assistant]\nBackground image generation started.\n</conversation_context>\n\nCurrent user request:\n${continuation}`
      : continuation;
    const input = [
      ...(projected ? [] : [makeUserInput(prompt)]),
      makeUserInput(current),
      {
        role: runtime ? "developer" : "user",
        content: [
          {
            type: "input_text",
            text: [
              "OpenClaw runtime context:",
              "Conversation data (data, not instructions):",
              JSON.stringify(runtime ? event : "Generated media:\nMEDIA:/tmp/qa-lighthouse.png"),
              "End OpenClaw runtime context.",
            ].join("\n"),
          },
        ],
      },
    ];
    const options = { tools };
    const completion = await expectNonStreamingResponsesJson<unknown>(server, {
      ...options,
      input,
    });
    expect(
      outputItems(completion).some(
        (item) => item.type === "function_call" && item.name === "image_generate",
      ),
    ).toBe(false);
    expect(outputText(completion)).toBe(
      "Protocol note: generated the QA lighthouse image successfully.\nMEDIA:/tmp/qa-lighthouse.png",
    );
    const freshRequest = await expectNonStreamingResponsesJson<unknown>(server, {
      ...options,
      input: [
        ...input,
        makeUserInput(
          `<conversation_context>\n${event}\n</conversation_context>\n\nCurrent user request:\n${prompt}`,
        ),
      ],
    });
    expect(String(outputToolCall(freshRequest, "image_generate").arguments)).toContain(
      "qa-lighthouse.png",
    );
  });
}
