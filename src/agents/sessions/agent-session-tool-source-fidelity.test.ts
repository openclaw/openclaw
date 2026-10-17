import fs from "node:fs/promises";
import path from "node:path";
import { streamAnthropic } from "@openclaw/ai/internal/anthropic";
import { streamOpenAIResponses } from "@openclaw/ai/internal/openai";
import type { Context, Model, ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resetLogger } from "../../logging/logger.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { createOpenClawReadTool } from "../agent-tools.read.js";
import { buildEmbeddedExtensionFactories } from "../embedded-agent-runner/extensions.js";
import { normalizeMessagesForLlmBoundary } from "../embedded-agent-runner/run/attempt-llm-boundary.js";
import { installToolResultContextGuard } from "../embedded-agent-runner/tool-result-context-guard.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { createReadTool } from "./tools/read.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);
afterEach(resetSecretRedactionRegistryForTest);
afterEach(resetLogger);

const textContent = (result: Pick<ToolResultMessage, "content"> | undefined) =>
  result?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

it.each([
  ["anthropic-messages", "read", ".env"],
  ["openai-responses", "read", "fixture.txt"],
] as const)("preserves file bytes for %s after %s returns %s", async (api, toolName, filename) => {
  const cwd = tempDirs.make("openclaw-tool-source-fidelity-");
  const fakeSecret = "fixture-registered-secret-0123456789";
  const vendorSecret = `sk-${"fixture".repeat(6)}`;
  const benignMarker = "VISIBLE_FILE_CONTENT";
  const sourceAssignment = "API_TOKEN = computeToken()";
  registerSecretValueForRedaction(fakeSecret);
  const fileContent = `${benignMarker}\nVALUE=${fakeSecret}\n${vendorSecret}\n${sourceAssignment}\n`;
  await fs.writeFile(path.join(cwd, filename), fileContent);
  const readTool = createOpenClawReadTool(createReadTool(cwd), { cwd });
  const readControl = await readTool.execute("direct-read-control", { path: filename });
  const readControlText = textContent(readControl);
  expect(readControlText).toBe(fileContent);

  const model: Model = {
    ...testModel,
    api,
    provider: api === "anthropic-messages" ? "anthropic" : "openai",
    id: api === "anthropic-messages" ? "claude-sonnet-4-6" : "gpt-4.1",
    baseUrl: "https://router.invalid",
  };
  const scope = {
    agentId: "main",
    sessionId: "tool-source-fidelity",
    sessionKey: "agent:main:tool-source-fidelity",
    storePath: path.join(cwd, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const sessionManager = guardSessionManager(await SessionManager.openAsync(scope, cwd), {
    config: {},
    allowedToolNames: [toolName],
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    extensionFactories: buildEmbeddedExtensionFactories({
      cfg: {},
      workspaceDir: cwd,
      sessionManager,
      model,
    }),
  });
  await resourceLoader.reload();
  let providerPayload: unknown;
  let liveContext: Context | undefined;
  const currentResult = () =>
    liveContext?.messages.findLast((message) => message.role === "toolResult");
  const probe = {
    type: "toolCall" as const,
    id: "probe-read",
    name: toolName,
    arguments: { path: filename },
  };
  streamMocks.streamSimple
    .mockImplementationOnce((activeModel: Model) =>
      createAssistantResultStream(createAssistant(activeModel, [probe], "toolUse")),
    )
    .mockImplementation((_activeModel, context, options) => {
      liveContext = context;
      const capture = async (payload: unknown, requestModel: Model) => {
        const replacement = await options?.onPayload?.(payload, requestModel);
        providerPayload = replacement === undefined ? payload : replacement;
        throw new Error("synthetic probe stops before any network operation");
      };
      const probeOptions = { ...options, apiKey: "synthetic-probe-auth", onPayload: capture };
      return api === "anthropic-messages"
        ? streamAnthropic(model as Model<"anthropic-messages">, context, probeOptions)
        : streamOpenAIResponses(model as Model<"openai-responses">, context, probeOptions);
    });
  const { session } = await createTestSession({
    model,
    sessionManager,
    resourceLoader,
    customTools: toToolDefinitions([readTool]),
  });
  const previousTransform = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) =>
    normalizeMessagesForLlmBoundary(
      previousTransform ? await previousTransform.call(session.agent, messages, signal) : messages,
    );
  const removeGuard = installToolResultContextGuard({
    agent: session.agent,
    contextWindowTokens: 32_768,
  });
  try {
    expect(session.getActiveToolNames().join(",")).toBe(toolName);
    await session.prompt(`Read ${filename}.`);
    expect(providerPayload !== undefined).toBe(true);
    const stored = JSON.stringify(sessionManager.getEntries());
    const liveToolResult = currentResult();
    const liveToolText = textContent(liveToolResult) ?? "";
    expect(liveToolResult).toMatchObject({ isError: false });
    for (const marker of [benignMarker, fakeSecret, vendorSecret]) {
      expect(JSON.stringify(providerPayload)).toContain(marker);
    }
    for (const secret of [fakeSecret, vendorSecret]) {
      expect(stored).toContain(secret);
    }
    expect(liveToolText).toBe(readControlText);
    const transcript = await SessionManager.openAsync(scope, cwd);
    const storedResult = transcript
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "toolResult");
    expect(storedResult?.type === "message" && storedResult.message).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: readControlText }],
    });
    await session.prompt("Continue using the previous read result.");
    expect(textContent(currentResult())).toBe(liveToolText);
  } finally {
    removeGuard();
    session.dispose();
  }
});
