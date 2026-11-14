import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveProviderContext } from "../../../../packages/ai/src/provider-types.js";
import { buildOpenAIResponsesParams } from "../../../../packages/ai/src/transports/openai-responses-params-internal.js";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.message.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { createUnsafeMountedSandbox } from "../../test-helpers/unsafe-mounted-sandbox.js";
import { log } from "../logger.js";
import {
  buildPromptImageFailureNotice,
  hydratePromptMediaMessages,
  materializeProviderContext,
} from "./images.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("records a lost sandbox image once across a real session tool loop and later turn", async () => {
  const workspaceDir = tempDirs.make("openclaw-image-retry-");
  const inbound = path.join(workspaceDir, "media/inbound");
  await fs.mkdir(inbound, { recursive: true });
  const bytes = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
  for (const name of ["lost", "retained"]) {
    await fs.writeFile(path.join(inbound, `${name}.png`), bytes);
  }
  const sandbox = createUnsafeMountedSandbox({
    sandboxRoot: workspaceDir,
    agentRoot: workspaceDir,
  });
  const bridge = sandbox.fsBridge;
  if (!bridge) {
    throw new Error("Expected sandbox filesystem bridge");
  }
  const read = vi.spyOn(bridge, "readFile");
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const onCurrentTurnImageFailure = vi.fn();
  const message = buildPersistedUserTurnMessage({
    text: "Inspect both attachments",
    idempotencyKey: "sandbox-image-retry",
    timestamp: 1,
    media: ["lost", "retained"].map((name) => ({
      path: `media/inbound/${name}.png`,
      url: `media://inbound/${name}.png`,
      workspaceDir,
      contentType: "image/png",
    })),
  });
  const options = {
    workspaceDir,
    model: { input: ["text", "image"] },
    sandbox: { root: workspaceDir, bridge },
    workspaceOnly: true,
    imageSessionKey: workspaceDir,
    onCurrentTurnImageFailure,
  };
  const manager = SessionManager.inMemory(workspaceDir);
  await manager.appendMessageAsync(message);
  let toolCalls = 0;
  const tool = {
    ...createStubTool("advance"),
    execute: async () => {
      if (++toolCalls === 1) {
        await fs.rm(path.join(inbound, "lost.png"));
        read.mockClear();
      }
      return { content: [{ type: "text" as const, text: "Advanced" }], details: {} };
    },
  };
  const { session } = await createTestSession({
    sessionManager: manager,
    model: { ...testModel, input: ["text", "image"] },
    customTools: [tool],
  });
  session.agent.transformContext = (messages) => hydratePromptMediaMessages(messages, options);
  const requests: string[] = [];
  session.agent.streamFn = wrapStreamFnWithMessageTransform(
    async (model, context, streamOptions) => {
      const provider = await resolveProviderContext(context, streamOptions);
      const messages = provider.messages.map((entry) => {
        if (entry.role !== "user") {
          return entry;
        }
        return {
          ...entry,
          content:
            typeof entry.content === "string"
              ? entry.content
              : entry.content.map((part) => {
                  if (part.type === "video") {
                    throw new Error("Unexpected video in image-only fixture");
                  }
                  return part;
                }),
        };
      });
      requests.push(
        JSON.stringify(buildOpenAIResponsesParams(model, { ...provider, messages }, undefined)),
      );
      return createAssistantResultStream(
        toolCalls < 3
          ? createAssistant(
              model,
              [{ type: "toolCall", id: `advance-${toolCalls}`, name: tool.name, arguments: {} }],
              "toolUse",
            )
          : createAssistant(
              model,
              "The retained image is available; please resend the missing image.",
            ),
      );
    },
    (messages) => messages,
    (input) => materializeProviderContext({ ...options, ...input }),
  );
  await session.prompt("Inspect both attachments", {
    persistedUserIdempotencyKey: message.idempotencyKey,
  });
  expect(toolCalls).toBe(3);
  expect(requests.map((request) => request.match(/"type":"input_image"/g)?.length ?? 0)).toEqual([
    2, 1, 1, 1,
  ]);
  for (const request of requests.slice(1)) {
    expect(request).toContain(buildPromptImageFailureNotice(1));
  }
  expect(session.getLastAssistantText()).toContain("please resend the missing image");
  expect(session.messages.filter((entry) => entry.role === "toolResult")).toHaveLength(3);
  expect(
    read.mock.calls.filter(([arg]) => arg.filePath === path.join(inbound, "lost.png")),
  ).toHaveLength(1);
  expect(warn.mock.calls).toEqual([["Native image: failed to load"]]);
  expect(onCurrentTurnImageFailure).toHaveBeenCalledWith(1);
  // Reappearing files must not silently change the established provider prefix.
  await fs.writeFile(path.join(inbound, "lost.png"), bytes);
  await session.prompt("Inspect the retained image again");
  expect(requests).toHaveLength(5);
  expect(requests[4]?.match(/"type":"input_image"/g)).toHaveLength(1);
  expect(requests[4]).toContain(buildPromptImageFailureNotice(1));
  expect(
    read.mock.calls.filter(([arg]) => arg.filePath === path.join(inbound, "lost.png")),
  ).toHaveLength(1);
});
