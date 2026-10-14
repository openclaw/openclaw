import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, assert, expect, it, vi } from "vitest";
import { buildAgentsApiToolSurface } from "./agentsapi-tools.js";
import { createModel } from "./agentsapi.test-support.js";

// mock-isolation: Transcript persistence is independent of Gateway file authorization.
vi.mock("./agentsapi-transcript.js", () => ({ recordAgentsApiToolTranscript: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it.each(["guarded", "read-only"] as const)(
  "keeps %s Gateway PDF reads inside the recorded root, not the nested cwd",
  async (permissionMode) => {
    await withToolSurface(
      { permissionMode, recordedRoot: true },
      async ({ execute, inside, outside }) => {
        // Plain text intentionally stops after the real file read, before PDF parsing or inference.
        expect(await execute("inside", inside)).toMatchObject({
          success: false,
          error: expect.stringContaining("Expected PDF but got"),
        });
        expect(await execute("outside", outside)).toMatchObject({
          success: false,
          error: expect.stringContaining("not under an allowed directory"),
        });
      },
    );
  },
);

it("uses the prepared workspace when a restricted session has no recorded root", async () => {
  await withToolSurface(
    { permissionMode: "guarded", recordedRoot: false },
    async ({ execute, inside, outside }) => {
      expect(await execute("inside", inside)).toMatchObject({
        success: false,
        error: expect.stringContaining("Expected PDF but got"),
      });
      expect(await execute("outside", outside)).toMatchObject({
        success: false,
        error: expect.stringContaining("not under an allowed directory"),
      });
    },
  );
});

it("retains default media access in full mode and forwards turn exec restrictions", async () => {
  await withToolSurface(
    {
      permissionMode: "full",
      recordedRoot: true,
      execOverrides: { security: "deny", ask: "always" },
    },
    async ({ execute, outside, construction }) => {
      expect(await execute("outside", outside)).toMatchObject({
        success: false,
        error: expect.stringContaining("Expected PDF but got"),
      });
      expect(construction.mock.calls[0]?.[0]).toMatchObject({
        exec: { security: "deny", ask: "always" },
      });
    },
  );
});

type ToolFixture = {
  execute: (
    id: string,
    file: string,
  ) => ReturnType<Awaited<ReturnType<typeof buildAgentsApiToolSurface>>["execute"]>;
  inside: string;
  outside: string;
  construction: ReturnType<
    typeof vi.fn<
      NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]["createToolSurfaceAsync"]>
    >
  >;
};

async function withToolSurface(
  options: {
    permissionMode: NonNullable<AgentHarnessAttemptParamsV2["permissionMode"]>;
    recordedRoot: boolean;
    execOverrides?: AgentHarnessAttemptParamsV2["execOverrides"];
  },
  run: (fixture: ToolFixture) => Promise<void>,
) {
  await withOpenClawTestState({ label: "agentsapi-gateway-permissions" }, async (state) => {
    const sessionRoot = options.recordedRoot
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
    const authStorage = AuthStorage.inMemory();
    const controller = new AbortController();
    const attempt = {
      agentId: "main",
      sessionId: "permission-session",
      sessionKey: "agent:main:permission-session",
      sessionFile: state.statePath("permission-session.jsonl"),
      workspaceDir: state.workspaceDir,
      cwd,
      ...(options.recordedRoot ? { sessionRoot } : {}),
      agentDir: state.agentDir(),
      permissionMode: options.permissionMode,
      execOverrides: options.execOverrides,
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
      runId: `permission-${options.permissionMode}`,
      prompt: "Inspect the synthetic document.",
      timeoutMs: 5_000,
      abortSignal: controller.signal,
      provider: "openai",
      modelId: "fixture-model",
      model: createModel(),
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      authProfileStore: { version: 1 as const, profiles: {} },
      thinkLevel: "off" as const,
    };
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
      await run({
        inside,
        outside,
        construction,
        execute: (id, file) =>
          surface.execute({
            type: "function_call",
            turn_id: "permission-turn",
            call_id: id,
            name: "pdf",
            arguments: { pdf: file },
          }),
      });
    } finally {
      controller.abort();
      for (const cleanup of cleanups.toReversed()) {
        await cleanup("Permission test complete");
      }
      host.close();
    }
  });
}
