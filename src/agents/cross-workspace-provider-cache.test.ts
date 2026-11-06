/**
 * Cross-workspace prompt cache proof test — captures actual provider requests.
 *
 * This test runs the actual agent through the native runtime with a mock provider,
 * capturing the outgoing requests to prove byte-identical stable prefixes across
 * separate workspaces with identical context files.
 *
 * Run with: pnpm test src/agents/cross-workspace-provider-cache.test.ts
 */
import path from "node:path";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expect, it, describe, afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { type NativeRuntimeConfig } from "../worker/native-runtime-config.js";
import { createNativeRuntime } from "../worker/native-runtime.js";
import { nativeProviderFixture, closeNativeServers } from "../worker/native-worker.test-support.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const servers: ReturnType<typeof nativeProviderFixture> extends Promise<infer T> ? T[] : never[] =
  [];
afterEach(async () => {
  await closeNativeServers(servers);
});

function extractSystemBlocks(requestBody: Record<string, unknown>): string[] {
  const system = requestBody.system;
  if (Array.isArray(system)) {
    return system
      .filter(
        (block): block is { type: string; text: string } =>
          block !== null &&
          typeof block === "object" &&
          block.type === "text" &&
          typeof block.text === "string",
      )
      .map((block) => block.text);
  }
  if (typeof system === "string") {
    return [system];
  }
  const messages = requestBody.messages;
  if (Array.isArray(messages)) {
    return messages
      .filter(
        (msg): msg is { role: string; content: string } =>
          msg !== null &&
          typeof msg === "object" &&
          msg.role === "system" &&
          typeof msg.content === "string",
      )
      .map((msg) => msg.content);
  }
  return [];
}

describe("Cross-workspace provider cache proof", () => {
  it("produces byte-identical stable prefixes in actual provider requests", async () => {
    const workspaceA = tempDirs.make("ws-a-");
    const workspaceB = tempDirs.make("ws-b-");

    const providerA = await nativeProviderFixture(
      servers,
      "local-model",
      () => "native response",
      "native response",
    );

    const configA: NativeRuntimeConfig = {
      models: [
        {
          provider: "openai",
          id: "local-model",
          api: "openai-completions",
          baseUrl: providerA.baseUrl,
          contextWindow: 8192,
          maxTokens: 256,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      workspace: workspaceA,
    };

    const providerB = await nativeProviderFixture(
      servers,
      "local-model",
      () => "native response",
      "native response",
    );

    const configB: NativeRuntimeConfig = {
      models: [
        {
          provider: "openai",
          id: "local-model",
          api: "openai-completions",
          baseUrl: providerB.baseUrl,
          contextWindow: 8192,
          maxTokens: 256,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      workspace: workspaceB,
    };

    const contextContent =
      "# Agent Instructions\n\nBe helpful and concise.\n\n## Rules\n- Follow user instructions\n- Use tools when needed\n- Be concise";

    const systemPromptA = buildAgentSystemPrompt({
      workspaceDir: workspaceA,
      contextFiles: [
        { path: path.join(workspaceA, "AGENTS.md"), content: contextContent },
        { path: path.join(workspaceA, "SOUL.md"), content: "# Soul\n\nHelpful and concise." },
        { path: path.join(workspaceA, "IDENTITY.md"), content: "# Identity\n\nTestAgent v1.0" },
      ],
    });

    const runtimeA = await createNativeRuntime(configA, {
      "openai/local-model": "fixture-key",
    });

    const contextA = {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      systemPrompt: systemPromptA,
    };

    await runtimeA.withTurn(
      {
        binding: { workspacePath: workspaceA, sessionId: "session-a" },
        selection: { provider: "openai", modelId: "local-model" },
      },
      async (resolved) => {
        const stream = await resolved.streamFn(resolved.model, contextA);
        return stream.result();
      },
    );

    await providerA.entered;

    const systemPromptB = buildAgentSystemPrompt({
      workspaceDir: workspaceB,
      contextFiles: [
        { path: path.join(workspaceB, "AGENTS.md"), content: contextContent },
        { path: path.join(workspaceB, "SOUL.md"), content: "# Soul\n\nHelpful and concise." },
        { path: path.join(workspaceB, "IDENTITY.md"), content: "# Identity\n\nTestAgent v1.0" },
      ],
    });

    const runtimeB = await createNativeRuntime(configB, {
      "openai/local-model": "fixture-key",
    });

    const contextB = {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      systemPrompt: systemPromptB,
    };

    await runtimeB.withTurn(
      {
        binding: { workspacePath: workspaceB, sessionId: "session-b" },
        selection: { provider: "openai", modelId: "local-model" },
      },
      async (resolved) => {
        const stream = await resolved.streamFn(resolved.model, contextB);
        return stream.result();
      },
    );

    await providerB.entered;

    expect(providerA.requests).toHaveLength(1);
    expect(providerB.requests).toHaveLength(1);

    const blocksA = extractSystemBlocks(providerA.requests[0]!.body as Record<string, unknown>);
    const blocksB = extractSystemBlocks(providerB.requests[0]!.body as Record<string, unknown>);

    const fullPromptA = blocksA[0]!;
    const fullPromptB = blocksB[0]!;

    expect(fullPromptA).not.toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(fullPromptB).not.toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);

    expect(fullPromptA).toContain("## AGENTS.md");
    expect(fullPromptA).toContain("## SOUL.md");
    expect(fullPromptA).toContain("## IDENTITY.md");
    expect(fullPromptA).not.toMatch(/## [A-Z]:\\/);
    expect(fullPromptA).not.toMatch(/## \//);

    expect(fullPromptB).toContain("## AGENTS.md");
    expect(fullPromptB).toContain("## SOUL.md");
    expect(fullPromptB).toContain("## IDENTITY.md");
    expect(fullPromptB).not.toMatch(/## [A-Z]:\\/);
    expect(fullPromptB).not.toMatch(/## \//);

    expect(fullPromptA).toContain("Working directory:");
    expect(fullPromptB).toContain("Working directory:");
    expect(fullPromptA).toContain(workspaceA);
    expect(fullPromptB).toContain(workspaceB);
    expect(fullPromptA).not.toContain(workspaceB);
    expect(fullPromptB).not.toContain(workspaceA);

    runtimeA.close();
    runtimeB.close();
  }, 60_000);
});
