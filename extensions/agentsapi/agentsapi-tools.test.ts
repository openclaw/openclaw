import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createAttemptParams } from "./agentsapi-attempt.test-helpers.js";
import { buildAgentsApiToolSurface } from "./agentsapi-tools.js";

// mock-isolation: Transcript persistence is independent of Gateway file authorization.
vi.mock("./agentsapi-transcript.js", () => ({ recordAgentsApiToolTranscript: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it.each([
  ["guarded", true],
  ["read-only", true],
  ["guarded", false],
  ["full", true],
] as const)("applies %s PDF access with recordedRoot=%s", async (permissionMode, recordedRoot) => {
  await withOpenClawTestState({ label: "agentsapi-gateway-permissions" }, async (state) => {
    const sessionRoot = recordedRoot
      ? path.join(state.workspaceDir, "project")
      : state.workspaceDir;
    const cwd = path.join(sessionRoot, "src");
    const inside = path.join(sessionRoot, "inside.txt");
    // Canvas is a default media root, but is outside this session's filesystem boundary.
    const outside = state.statePath("canvas", "outside.txt");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(inside, "synthetic inside document");
    await fs.writeFile(outside, "synthetic outside document");
    const controller = new AbortController();
    const attempt = createAttemptParams({
      sessionId: "permission-session",
      sessionKey: "agent:main:permission-session",
      sessionFile: state.statePath("permission-session.jsonl"),
      workspaceDir: state.workspaceDir,
      cwd,
      ...(recordedRoot ? { sessionRoot } : {}),
      agentDir: state.agentDir(),
      permissionMode,
      execOverrides: permissionMode === "full" ? { security: "deny", ask: "always" } : undefined,
      config: {
        plugins: { allow: [] },
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            pdfModel: { primary: "openai/fixture-model" },
          },
        },
        tools: { allow: ["pdf"], fs: { workspaceOnly: false } },
        skills: { load: { watch: false } },
      },
      runId: `permission-${permissionMode}`,
      prompt: "Inspect the synthetic document.",
      timeoutMs: 5_000,
      abortSignal: controller.signal,
    });
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt,
      pluginId: "agentsapi",
    });
    const create = host.capabilities.createToolSurfaceAsync;
    assert(create);
    const construction = vi.fn(create);
    const params: AgentHarnessAttemptParamsV2 = {
      ...attempt,
      hostCapabilities: { ...host.capabilities, createToolSurfaceAsync: construction },
    };
    const cleanups: Array<(reason: string) => Promise<void>> = [];
    try {
      const surface = await buildAgentsApiToolSurface(
        params,
        controller.signal,
        host.capabilities.assertActive,
        (cleanup) => cleanups.push(cleanup),
      );
      expect(surface.declarations.map((tool) => tool.name)).toContain("pdf");
      const execute = (id: string, file: string) =>
        surface.execute({
          type: "function_call",
          turn_id: "permission-turn",
          call_id: id,
          name: "pdf",
          arguments: { pdf: file },
        });
      // Plain text reaches the real file read but stops before parsing or inference.
      if (permissionMode !== "full") {
        expect(await execute("inside", inside)).toMatchObject({
          success: false,
          error: expect.stringContaining("Expected PDF but got"),
        });
      }
      expect(await execute("outside", outside)).toMatchObject({
        success: false,
        error: expect.stringContaining(
          permissionMode === "full" ? "Expected PDF but got" : "not under an allowed directory",
        ),
      });
      if (permissionMode === "full") {
        expect(construction.mock.calls[0]?.[0]).toMatchObject({
          exec: { security: "deny", ask: "always" },
        });
      }
    } finally {
      controller.abort();
      for (const cleanup of cleanups.toReversed()) {
        await cleanup("Permission test complete");
      }
      host.close();
    }
  });
});
