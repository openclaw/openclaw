import fs from "node:fs/promises";
import path from "node:path";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { resolveProviderContext, type ProviderContext } from "@openclaw/ai/provider-types";
import { describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { bindStreamLlmRuntime } from "../../../llm/model-runtime-binding.js";
import {
  attachModelProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../../plugins/provider-hook-runtime.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { StreamFn } from "../../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { prepareEmbeddedAttemptTransport } from "./attempt-stream-settle.js";

// Register the shared module mocks before importing any runtime dependency.
const { createFixture } = await vi.hoisted(
  async () => await import("./attempt-execution-phase.test-support.js"),
);

describe("embedded provider image handoff", () => {
  it("keeps images within the configured imageMaxDimensionPx", async () => {
    await withOpenClawTestState({ label: "provider-image-limits" }, async (testState) => {
      const image = createSolidPngBuffer(1600, 8, { r: 0, g: 0, b: 255 });
      const imagePath = path.join(testState.workspaceDir, "wide.png");
      await fs.writeFile(imagePath, image);
      let provider: ProviderContext | undefined;
      const providerStream: StreamFn = async (_model, context, options) => {
        provider = await resolveProviderContext(context, options);
        return createAssistantResultStream(createAssistant(model, "ok"));
      };
      const runtimeHandle: ProviderRuntimePluginHandle = {
        provider: testModel.provider,
        plugin: {
          id: testModel.provider,
          label: "Test",
          auth: [],
          createStreamFn: () => providerStream,
        },
      };
      const model = attachModelProviderRuntimePluginHandle(
        { ...testModel, input: ["text" as const, "image" as const] },
        runtimeHandle,
      );
      const fixture = await createFixture({ exerciseTerminalMerges: false });
      Object.assign(fixture.input.attempt, {
        config: { agents: { defaults: { imageMaxDimensionPx: 2400 } } },
        model,
        modelId: model.id,
        provider: model.provider,
        resolvedApiKey: "test-key",
        workspaceDir: testState.workspaceDir,
        runtimePlan: { auth: {}, transport: { resolveExtraParams: () => ({}) } },
      });
      const session = fixture.input.prepared.sessionRuntime.agentSession.activeSession;
      bindStreamLlmRuntime(session.agent.streamFn!, defaultLlmRuntime);
      await prepareEmbeddedAttemptTransport({
        attempt: fixture.input.attempt,
        session,
        settingsManager: createAutoCompactionSettings(),
        providerThinkingLevel: undefined,
        sessionAgentId: "main",
        workspaceDir: testState.workspaceDir,
        workspaceOnly: true,
        agentDir: testState.agentDir(),
        abortSignal: fixture.input.runAbortController.signal,
        getProviderRuntimeHandle: () => runtimeHandle,
        sandboxSessionKey: "agent:main:main",
        codeModeControlsEnabled: false,
        providerPromptState: { state: {}, effectiveContextTokenBudget: 32_768 },
      });
      const message = {
        role: "user" as const,
        content: "describe the attachment",
        timestamp: 1,
        __openclaw: { media: [{ path: imagePath, contentType: "image/png" }] },
      };
      await (await session.agent.streamFn!(model, { messages: [message] }, {})).result();

      expect(provider?.messages[0]?.content).toContainEqual({
        type: "image",
        data: image.toString("base64"),
        mimeType: "image/png",
      });
    });
  });
});
