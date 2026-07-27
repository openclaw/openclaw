import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();
const GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";

afterEach(cleanup);

async function createNativeImageScenarioHarness(options?: {
  artifact?: "valid" | "empty" | "missing";
  delivery?:
    | "valid"
    | "text-only"
    | "empty-image"
    | "wrong-image"
    | "wrong-kind"
    | "wrong-mime"
    | "duplicate-attachments";
  duplicateDelivery?: boolean;
}) {
  const scenario = readQaScenarioById("native-image-generation");
  const flow = scenario.execution.flow;
  if (!flow) {
    throw new Error("native image generation scenario has no flow");
  }

  const state = createQaBusState();
  const env = {
    providerMode: "mock-openai",
    mock: { baseUrl: "http://qa-image.example.test" },
  };
  const sessionKey = "agent:qa:image-generate";
  const tempDir = await makeTempDir("qa-native-image-scenario-");
  const imagePath = path.join(tempDir, "generated-image.png");
  if (options?.artifact !== "missing") {
    const contents =
      options?.artifact === "empty"
        ? Buffer.alloc(0)
        : Buffer.from(GENERATED_IMAGE_BASE64, "base64");
    await fs.writeFile(imagePath, contents);
  }

  const createSession = vi.fn(async (_env: unknown, _label: string, requestedKey: string) => {
    if (requestedKey !== sessionKey) {
      throw new Error("image generation did not request a QA-owned session");
    }
    return sessionKey;
  });
  const readEffectiveTools = vi.fn(async (_env: unknown, key: string) => {
    if (key !== sessionKey) {
      throw new Error("image tool inventory was read for a different session");
    }
    return new Set(["image_generate"]);
  });
  const runAgentPrompt = vi.fn(
    async (_env: unknown, input: { sessionKey: string; message: string }) => {
      if (input.sessionKey !== sessionKey) {
        throw new Error("image generation ran in a different session");
      }
      const deliveries = options?.duplicateDelivery ? 2 : 1;
      for (let index = 0; index < deliveries; index += 1) {
        const generatedAttachment: {
          id: string;
          kind: "image" | "file";
          mimeType: string;
          contentBase64: string;
        } = {
          id: `native-generated-image-${index}`,
          kind: "image",
          mimeType: "image/png",
          contentBase64: GENERATED_IMAGE_BASE64,
        };
        let attachments = [generatedAttachment];
        switch (options?.delivery) {
          case "text-only":
            attachments = [];
            break;
          case "empty-image":
            attachments = [{ ...generatedAttachment, contentBase64: "" }];
            break;
          case "wrong-image":
            attachments = [
              {
                ...generatedAttachment,
                contentBase64: Buffer.from("not the generated PNG").toString("base64"),
              },
            ];
            break;
          case "wrong-kind":
            attachments = [{ ...generatedAttachment, kind: "file" }];
            break;
          case "wrong-mime":
            attachments = [{ ...generatedAttachment, mimeType: "image/jpeg" }];
            break;
          case "duplicate-attachments":
            attachments = [
              generatedAttachment,
              { ...generatedAttachment, id: `${generatedAttachment.id}-duplicate` },
            ];
            break;
        }
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-operator",
          text: "Generated QA lighthouse image",
          attachments,
        });
      }
    },
  );
  const fetchJson = vi.fn(async (url: string) => {
    if (url.endsWith("/debug/image-generations")) {
      return [{ model: "gpt-image-1", n: 1 }];
    }
    return [
      {
        allInputText: scenario.execution.config?.promptSnippet,
        plannedToolName: "image_generate",
        body: { tools: [{ type: "function", name: "image_generate" }] },
        toolOutput: "DO_NOT_EXPOSE_RAW_TOOL_OUTPUT",
      },
    ];
  });
  const runQaCli = vi.fn(async () => ({
    tasks: [
      {
        taskKind: "image_generation",
        status: "succeeded",
        deliveryStatus: "delivered",
      },
    ],
  }));

  const api = {
    env,
    state,
    scenario,
    config: scenario.execution.config ?? {},
    fs,
    createSession,
    readEffectiveTools,
    runAgentPrompt,
    fetchJson,
    runQaCli,
    ensureImageGenerationConfigured: vi.fn(async () => undefined),
    liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
    reset: async () => state.reset(),
    resolveGeneratedImagePath: vi.fn(async () => imagePath),
    sleep: vi.fn(async () => undefined),
    waitForOutboundMessage: async (
      currentState: typeof state,
      predicate: (message: ReturnType<typeof state.getSnapshot>["messages"][number]) => boolean,
    ) => {
      const message = currentState.getSnapshot().messages.find(predicate);
      if (!message) {
        throw new Error("image generation did not deliver to the QA operator");
      }
      return message;
    },
    formatTransportTranscript: (currentState: typeof state) =>
      currentState
        .getSnapshot()
        .messages.map(
          (message) => `${message.direction}:${message.conversation.id}:${message.text}`,
        )
        .join("\n"),
    runScenario: async (
      name: string,
      steps: Array<{ name: string; run: () => Promise<string | void> }>,
    ) => {
      const results = [];
      for (const step of steps) {
        const details = await step.run();
        results.push({
          name: step.name,
          status: "pass" as const,
          ...(details === undefined ? {} : { details }),
        });
      }
      return { name, status: "pass" as const, steps: results };
    },
  } satisfies Parameters<typeof runScenarioFlow>[0]["api"];

  return {
    createSession,
    imagePath,
    readEffectiveTools,
    run: () => runScenarioFlow({ api, flow, scenarioTitle: scenario.title }),
    runAgentPrompt,
    sessionKey,
    state,
  };
}

describe("native image generation scenario", () => {
  it("generates and delivers a nonempty image in the created session exactly once", async () => {
    const harness = await createNativeImageScenarioHarness();

    const result = await harness.run();

    expect(result).toMatchObject({
      status: "pass",
      steps: [
        {
          status: "pass",
          details: expect.stringContaining(`IMAGE_PATH:${harness.imagePath}`),
        },
      ],
    });
    expect(harness.createSession).toHaveBeenCalledOnce();
    expect(harness.createSession).toHaveBeenCalledWith(
      expect.anything(),
      "Image generation",
      harness.sessionKey,
    );
    expect(harness.readEffectiveTools).toHaveBeenCalledWith(expect.anything(), harness.sessionKey);
    expect(harness.runAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionKey: harness.sessionKey }),
    );
    expect((await fs.stat(harness.imagePath)).size).toBeGreaterThan(0);
    const outboundMessages = harness.state
      .getSnapshot()
      .messages.filter(
        (message) => message.direction === "outbound" && message.conversation.id === "qa-operator",
      );
    expect(outboundMessages).toHaveLength(1);
    expect(outboundMessages[0]?.attachments).toEqual([
      expect.objectContaining({
        kind: "image",
        mimeType: "image/png",
        contentBase64: GENERATED_IMAGE_BASE64,
      }),
    ]);
    expect(Buffer.from(outboundMessages[0]!.attachments![0]!.contentBase64!, "base64")).toEqual(
      await fs.readFile(harness.imagePath),
    );
  });

  it("rejects an empty generated image", async () => {
    const harness = await createNativeImageScenarioHarness({ artifact: "empty" });

    await expect(harness.run()).rejects.toThrow(
      "image generation did not produce a nonempty saved media file",
    );
  });

  it("rejects a missing generated image", async () => {
    const harness = await createNativeImageScenarioHarness({ artifact: "missing" });

    await expect(harness.run()).rejects.toThrow("ENOENT");
  });

  it.each([
    { delivery: "text-only" as const, description: "a text-only acknowledgment" },
    { delivery: "empty-image" as const, description: "an empty image attachment" },
    { delivery: "wrong-image" as const, description: "different image bytes" },
    { delivery: "wrong-kind" as const, description: "a non-image attachment" },
    { delivery: "wrong-mime" as const, description: "a non-PNG image attachment" },
    { delivery: "duplicate-attachments" as const, description: "duplicate image attachments" },
  ])("rejects $description as generated image delivery", async ({ delivery }) => {
    const harness = await createNativeImageScenarioHarness({ delivery });
    const result = harness.run();

    await expect(result).rejects.toThrow("expected exactly one generated-media delivery, saw 1");
    await expect(result).rejects.toThrow("matchesGeneratedImage");
    await expect(result).rejects.not.toThrow("DO_NOT_EXPOSE_RAW_TOOL_OUTPUT");
  });

  it("rejects duplicate generated-image deliveries", async () => {
    const harness = await createNativeImageScenarioHarness({ duplicateDelivery: true });
    const result = harness.run();

    await expect(result).rejects.toThrow("expected exactly one generated-media delivery, saw 2");
    await expect(result).rejects.toThrow("providerRequests=");
    await expect(result).rejects.toThrow("imageRequests=");
    await expect(result).rejects.toThrow("imageTasks=");
    await expect(result).rejects.toThrow("deliveries=");
    await expect(result).rejects.toThrow('"deleted":false');
    await expect(result).rejects.toThrow('"deletedAt":null');
    await expect(result).rejects.toThrow("attachmentCount");
    await expect(result).rejects.toThrow("byteLength");
    await expect(result).rejects.toThrow("matchesGeneratedImage");
    await expect(result).rejects.not.toThrow("DO_NOT_EXPOSE_RAW_TOOL_OUTPUT");
  });
});
