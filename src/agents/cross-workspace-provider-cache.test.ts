/**
 * Cross-workspace prompt cache proof test — captures actual provider requests.
 */
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { Context } from "@openclaw/ai";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expect, it, describe, afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { NativeRuntimeConfig } from "../worker/native-runtime-config.js";
import { createNativeRuntime, type NativeRuntime } from "../worker/native-runtime.js";
import { closeNativeServers, nativeProviderFixture } from "../worker/native-worker.test-support.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtimes: NativeRuntime[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) {
    r.close();
  }
  await closeNativeServers(servers);
});

describe("Cross-workspace provider cache proof", () => {
  it("produces byte-identical stable prefixes in actual provider requests", async () => {
    const wsA = tempDirs.make("ws-a-");
    const wsB = tempDirs.make("ws-b-");
    const runWs = async (ws: string) => {
      await fs.writeFile(`${ws}/AGENTS.md`, "# Agent Instructions\nBe helpful.");
      await fs.writeFile(`${ws}/SOUL.md`, "[MISSING] Expected at: /old/TOOLS.md\n# Soul\nConcise.");
      await fs.writeFile(`${ws}/IDENTITY.md`, "# Identity\nv1.0");
      const { contextFiles } = await resolveBootstrapContextForRun({ workspaceDir: ws });
      contextFiles.push({
        path: `${ws}/TOOLS.md`,
        content: `[MISSING] Expected at: ${ws}/TOOLS.md`.slice(0, 27) + "…",
        missing: true,
      });
      const p = await nativeProviderFixture(
        servers,
        "local-model",
        () => "native response",
        "native response",
      );
      const cfg: NativeRuntimeConfig = {
        models: [
          {
            provider: "openai",
            id: "local-model",
            api: "openai-completions",
            baseUrl: p.baseUrl,
            contextWindow: 8192,
            maxTokens: 256,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        workspace: ws,
      };
      const systemPrompt = buildAgentSystemPrompt({ workspaceDir: ws, contextFiles });
      const rt = await createNativeRuntime(cfg, { "openai/local-model": "fixture-key" });
      runtimes.push(rt);
      const ctx: Context = {
        messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
        systemPrompt,
      };
      await rt.withTurn(
        {
          binding: { workspacePath: ws },
          selection: { provider: "openai", modelId: "local-model" },
        },
        async (r) => (await r.streamFn(r.model, ctx)).result(),
      );
      await p.entered;
      const msgs =
        (p.requests[0]!.body as { messages?: { role: string; content: string }[] }).messages ?? [];
      const fullPrompt = msgs.find((m) => m.role === "system")?.content ?? "";
      return { systemPrompt, fullPrompt };
    };

    const a = await runWs(wsA);
    const b = await runWs(wsB);
    expect(a.systemPrompt.split(SYSTEM_PROMPT_CACHE_BOUNDARY)[0]).toBe(
      b.systemPrompt.split(SYSTEM_PROMPT_CACHE_BOUNDARY)[0],
    );

    const dirMarker = "Working directory:";
    const idx = a.fullPrompt.indexOf(dirMarker);
    expect(idx).toBeGreaterThan(0);
    expect(b.fullPrompt.indexOf(dirMarker)).toBe(idx);
    expect(a.fullPrompt.slice(0, idx)).toBe(b.fullPrompt.slice(0, idx));

    for (const [prompt, ws, otherWs] of [
      [a.fullPrompt, wsA, wsB],
      [b.fullPrompt, wsB, wsA],
    ] as const) {
      expect(prompt).not.toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
      for (const t of [
        "## AGENTS.md",
        "## SOUL.md",
        "## IDENTITY.md",
        "## BOOTSTRAP.md",
        "## TOOLS.md",
        "[MISSING] Expected at: BOOTSTRAP.md",
        "[MISSING] Expected at: TOOL…",
        "# Soul\nConcise.",
        "[MISSING] Expected at: /old/TOOLS.md",
        dirMarker,
        ws,
      ]) {
        expect(prompt).toContain(t);
      }
      expect(prompt).not.toMatch(/## [A-Z]:\\/);
      expect(prompt).not.toMatch(/## \//);
      expect(prompt).not.toContain(otherWs);
    }
  }, 60_000);
});
