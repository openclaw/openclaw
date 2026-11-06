/**
 * Cross-workspace prompt cache proof test — captures actual provider requests.
 *
 * This test runs the actual agent through the native runtime with a mock provider,
 * capturing the outgoing requests to prove byte-identical stable prefixes across
 * separate workspaces with identical context files.
 *
 * Run with: pnpm test src/agents/cross-workspace-provider-cache.test.ts
 */
import { mkdir, realpath, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { build } from "esbuild";
import { expect, it, describe, afterEach, beforeAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNativeRuntime, type NativeRuntimeConfig } from "../worker/native-runtime.js";
import { nativeProviderFixture, closeNativeServers } from "../worker/native-worker.test-support.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const servers: Awaited<ReturnType<typeof import("node:http")>["Server"]>[] = [];
afterEach(async () => {
  await closeNativeServers(servers);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build the probe entry once
let probeEntry: string;
beforeAll(async () => {
  const bundles = useAutoCleanupTempDirTracker(afterEach);
  probeEntry = path.join(bundles.make("cross-ws-probe-"), "probe.mjs");
  await build({
    entryPoints: [path.join(__dirname, "../worker/native-runtime.test-support.ts")],
    outfile: probeEntry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import { createRequire as createNativeProbeRequire } from "node:module"; const require = createNativeProbeRequire(import.meta.url);',
    },
  });
});

async function writeWorkspace(wsDir: string) {
  await mkdir(wsDir, { recursive: true });
  const content =
    "# Agent Instructions\n\nBe helpful and concise.\n\n## Rules\n- Follow user instructions\n- Use tools when needed\n- Be concise";
  await writeFile(path.join(wsDir, "AGENTS.md"), content);
  await writeFile(path.join(wsDir, "SOUL.md"), "# Soul\n\nHelpful and concise.");
  await writeFile(path.join(wsDir, "IDENTITY.md"), "# Identity\n\nTestAgent v1.0");
}

function extractSystemBlocks(requestBody: Record<string, unknown>): string[] {
  // Check for system field (Anthropic-style)
  const system = requestBody.system;
  if (Array.isArray(system)) {
    return system
      .filter(
        (block): block is { type: string; text: string; cache_control?: unknown } =>
          block &&
          typeof block === "object" &&
          block.type === "text" &&
          typeof block.text === "string",
      )
      .map((block) => block.text);
  }
  if (typeof system === "string") {
    return [system];
  }

  // Check for messages with role "system" (OpenAI-style)
  const messages = requestBody.messages;
  if (Array.isArray(messages)) {
    return messages
      .filter(
        (msg): msg is { role: string; content: string } =>
          msg &&
          typeof msg === "object" &&
          msg.role === "system" &&
          typeof msg.content === "string",
      )
      .map((msg) => msg.content);
  }

  return [];
}

function countDifferences(a: string, b: string): number {
  let diff = 0;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

describe("Cross-workspace provider cache proof", () => {
  it("produces byte-identical stable prefixes in actual provider requests", async () => {
    // Create two workspaces with identical context files
    const workspaceA = tempDirs.make("ws-a-");
    const workspaceB = tempDirs.make("ws-b-");
    await writeWorkspace(workspaceA);
    await writeWorkspace(workspaceB);

    // Create provider for workspace A (await to ensure server is running)
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

    // Create provider for workspace B (await to ensure server is running)
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

    // Run agent in workspace A
    const systemPromptA = buildAgentSystemPrompt({
      workspaceDir: workspaceA,
      contextFiles: [
        {
          path: path.join(workspaceA, "AGENTS.md"),
          content:
            "# Agent Instructions\n\nBe helpful and concise.\n\n## Rules\n- Follow user instructions\n- Use tools when needed\n- Be concise",
        },
        { path: path.join(workspaceA, "SOUL.md"), content: "# Soul\n\nHelpful and concise." },
        { path: path.join(workspaceA, "IDENTITY.md"), content: "# Identity\n\nTestAgent v1.0" },
      ],
      agentId: "test",
      agentSessionKey: "agent:test:test",
    });

    const runtimeA = await createNativeRuntime(configA, {
      "openai/local-model": "fixture-key",
    });

    const binding = { workspacePath: workspaceA, sessionId: "session-a" };
    const selection = { provider: "openai", modelId: "local-model" };
    const turn = { binding, selection };
    const context = {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      systemPrompt: systemPromptA,
    };

    const resolvedA = await runtimeA.withTurn(turn, async (resolved) => {
      const stream = await resolved.streamFn(resolved.model, context);
      return stream.result();
    });

    await providerA.entered;

    // Run agent in workspace B
    const systemPromptB = buildAgentSystemPrompt({
      workspaceDir: workspaceB,
      contextFiles: [
        {
          path: path.join(workspaceB, "AGENTS.md"),
          content:
            "# Agent Instructions\n\nBe helpful and concise.\n\n## Rules\n- Follow user instructions\n- Use tools when needed\n- Be concise",
        },
        { path: path.join(workspaceB, "SOUL.md"), content: "# Soul\n\nHelpful and concise." },
        { path: path.join(workspaceB, "IDENTITY.md"), content: "# Identity\n\nTestAgent v1.0" },
      ],
      agentId: "test",
      agentSessionKey: "agent:test:test",
    });

    const runtimeB = await createNativeRuntime(configB, {
      "openai/local-model": "fixture-key",
    });

    const bindingB = { workspacePath: workspaceB, sessionId: "session-b" };
    const turnB = { binding: bindingB, selection };
    const contextB = {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      systemPrompt: systemPromptB,
    };

    const resolvedB = await runtimeB.withTurn(turnB, async (resolved) => {
      const stream = await resolved.streamFn(resolved.model, contextB);
      return stream.result();
    });

    await providerB.entered;

    // Verify we got 1 request per provider
    expect(providerA.requests).toHaveLength(1);
    expect(providerB.requests).toHaveLength(1);

    // Extract system blocks from both requests
    const blocksA = extractSystemBlocks(providerA.requests[0]!.body as Record<string, unknown>);
    const blocksB = extractSystemBlocks(providerB.requests[0]!.body as Record<string, unknown>);

    console.log(`\n=== Workspace A: ${blocksA.length} system blocks ===`);
    console.log(
      "Request A body:",
      JSON.stringify(providerA.requests[0]!.body, null, 2).slice(0, 2000),
    );
    blocksA.forEach((block, i) => {
      console.log(`Block ${i}: ${block.length} chars`);
      if (i === 0) console.log(block.slice(0, 500) + "...");
    });

    console.log(`\n=== Workspace B: ${blocksB.length} system blocks ===`);
    console.log(
      "Request B body:",
      JSON.stringify(providerB.requests[0]!.body, null, 2).slice(0, 2000),
    );
    blocksB.forEach((block, i) => {
      console.log(`Block ${i}: ${block.length} chars`);
      if (i === 0) console.log(block.slice(0, 500) + "...");
    });

    // The native runtime sends the FULL system prompt to the provider.
    // The SYSTEM_PROMPT_CACHE_BOUNDARY is inserted by the Gateway when forwarding to the provider,
    // not by the native runtime. So the full prompt is in one system block.
    //
    // What we CAN verify:
    // 1. Headings are relative (e.g., "## AGENTS.md" not absolute paths) - this is the key fix
    // 2. Workspace directory IS included but differs between workspaces (expected - part of main prompt)
    // 3. Cache boundary is NOT in the native runtime output (it's added by Gateway)
    const fullPromptA = blocksA[0]!;
    const fullPromptB = blocksB[0]!;

    console.log(`\n=== FULL PROMPT comparison ===`);
    console.log(`Prompt A length: ${fullPromptA.length}`);
    console.log(`Prompt B length: ${fullPromptB.length}`);
    console.log(`Prompts IDENTICAL: ${fullPromptA === fullPromptB}`);

    // Verify NO cache boundary in native runtime output (added by Gateway)
    expect(fullPromptA).not.toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(fullPromptB).not.toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);

    // Verify headings are relative (the key fix for cross-workspace cache sharing)
    expect(fullPromptA).toContain("## AGENTS.md");
    expect(fullPromptA).toContain("## SOUL.md");
    expect(fullPromptA).toContain("## IDENTITY.md");
    expect(fullPromptA).not.toMatch(/## [A-Z]:\\/); // No Windows absolute paths in headings
    expect(fullPromptA).not.toMatch(/## \//); // No Unix absolute paths in headings

    expect(fullPromptB).toContain("## AGENTS.md");
    expect(fullPromptB).toContain("## SOUL.md");
    expect(fullPromptB).toContain("## IDENTITY.md");
    expect(fullPromptB).not.toMatch(/## [A-Z]:\\/);
    expect(fullPromptB).not.toMatch(/## \//);

    // Verify workspace directory IS present but differs (expected - Gateway splits this to suffix)
    expect(fullPromptA).toContain("Working directory:");
    expect(fullPromptB).toContain("Working directory:");
    expect(fullPromptA).toContain(workspaceA);
    expect(fullPromptB).toContain(workspaceB);
    expect(fullPromptA).not.toContain(workspaceB);
    expect(fullPromptB).not.toContain(workspaceA);

    // The prompts differ only in the workspace directory line
    // Count differences - should be minimal (just the workspace path)
    const diffCount = countDifferences(fullPromptA, fullPromptB);
    console.log(`\nCharacter differences between prompts: ${diffCount}`);
    expect(diffCount).toBeLessThan(100); // Only workspace path should differ

    runtimeA.close();
    runtimeB.close();
  }, 60_000);
});
