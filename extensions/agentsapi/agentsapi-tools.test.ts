import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { Type } from "typebox";
import { afterEach, assert, describe, expect, it, vi, type Mock } from "vitest";
import { createAttemptParams } from "./agentsapi-attempt.test-helpers.js";
import { buildAgentsApiToolSurface, type AgentsApiToolSurface } from "./agentsapi-tools.js";

// mock-isolation: Transcript persistence is independent of Gateway file authorization.
vi.mock("./agentsapi-transcript.js", () => ({ recordAgentsApiToolTranscript: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it("records source payloads separately from outbound message targets", async () => {
  const tool: AnyAgentTool = {
    name: "message",
    label: "Fixture message",
    description: "Returns a synthetic messaging transport result",
    parameters: Type.Object(
      {
        action: Type.Literal("send"),
        message: Type.String(),
        final: Type.Boolean(),
        channel: Type.Optional(Type.String()),
        target: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    execute: async (id) => ({
      content: [{ type: "text", text: "Sent" }],
      details:
        id === "outbound"
          ? { messageId: "fixture-outbound" }
          : {
              sourceReplySink: "internal-ui",
              deliveryStatus: "sent",
              sourceReply: { text: "Delivered source reply" },
            },
    }),
  };
  await withFixtureTool(tool, async (surface) => {
    await execute(surface, "message", "source", {
      action: "send",
      message: "Requested source reply",
      final: false,
    });
    await execute(surface, "message", "outbound", {
      action: "send",
      message: "Outbound text",
      final: true,
      channel: "slack",
      target: "C123",
    });
    expect(surface.delivery).toMatchObject({
      didSendViaMessagingTool: true,
      messagingToolSourceReplyPayloads: [
        { text: "Delivered source reply", sourceReplyFinal: false },
      ],
      messagingToolSentTexts: ["Outbound text"],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [
        { tool: "message", provider: "slack", to: "C123", text: "Outbound text" },
      ],
    });
  });
});

it("serializes mixed tool output and supplies the empty-output fallback", async () => {
  const tool: AnyAgentTool = {
    name: "fixture_output",
    label: "Fixture output",
    description: "Returns synthetic external tool content",
    parameters: Type.Object({ empty: Type.Boolean() }, { additionalProperties: false }),
    execute: async (id) => ({
      content:
        id === "output-true"
          ? []
          : [
              { type: "text", text: "First" },
              { type: "image", data: "AA==", mimeType: "image/png" },
              { type: "text", text: "Last" },
            ],
      details: {},
    }),
  };
  await withFixtureTool(tool, async (surface) => {
    for (const [empty, output] of [
      [false, "First\n[Image result omitted from Agents API function output]\nLast"],
      [true, "Tool completed with no text output."],
    ] as const) {
      expect(await execute(surface, tool.name, `output-${empty}`, { empty })).toEqual({
        success: true,
        output,
      });
    }
  });
});

describe("a delivered send to a configured delivery target", () => {
  // Shape of a cron send: the delivery target is the current source and the
  // message tool confirms the source reply.
  const tool: AnyAgentTool = {
    name: "message",
    label: "Fixture message",
    description: "Fixture message tool",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
      details: {
        ok: true,
        messageDelivery: {
          status: "settled",
          partialDelivery: false,
          createdThreadIds: [],
          sourceReplyDelivered: true,
        },
      },
    }),
  };
  it.each([
    { finalByDefault: false, final: undefined, ends: false },
    { finalByDefault: false, final: true, ends: true },
    // Chat turns keep the default: an omitted final ends the turn.
    { finalByDefault: undefined, final: undefined, ends: true },
  ])(
    "ends the native turn only when final resolves true (default $finalByDefault, final $final)",
    async ({ finalByDefault, final, ends }) => {
      await withFixtureTool(
        tool,
        async (surface) => {
          const result = await execute(surface, "message", "send-call", {
            action: "send",
            message: "daily drop",
            ...(final === undefined ? {} : { final }),
          });

          expect(result.terminate).toBe(ends ? true : undefined);
          // Delivery facts do not depend on whether the turn ends.
          expect(surface.delivery.sourceReplyDelivered).toBe(true);
        },
        finalByDefault,
      );
    },
  );
});

async function withFixtureTool(
  tool: AnyAgentTool,
  run: (surface: Awaited<ReturnType<typeof buildAgentsApiToolSurface>>) => Promise<void>,
  messageToolFinalByDefault?: boolean,
) {
  await withOpenClawTestState({ label: "agentsapi-tool-results" }, async (state) => {
    const attempt = createAttemptParams({
      workspaceDir: state.workspaceDir,
      agentDir: state.agentDir(),
      sessionFile: state.statePath("fixture-session.jsonl"),
      config: { plugins: { allow: [] } },
      ...(messageToolFinalByDefault === undefined ? {} : { messageToolFinalByDefault }),
    });
    await withSurface(attempt, new AbortController(), run, tool);
  });
}

function execute(surface: AgentsApiToolSurface, name: string, call_id: string, args: object) {
  return surface.execute({
    type: "function_call",
    turn_id: "fixture-turn",
    call_id,
    name,
    arguments: args,
  });
}

async function withSurface(
  attempt: AgentHarnessAttemptParamsV2,
  controller: AbortController,
  run: (
    surface: AgentsApiToolSurface,
    construction: Mock<
      NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]["createToolSurfaceAsync"]>
    >,
  ) => Promise<void>,
  tool?: AnyAgentTool,
) {
  const host = await createAgentHarnessHostCapabilitiesForTest({ attempt, pluginId: "agentsapi" });
  const create = host.capabilities.createToolSurfaceAsync;
  assert(create);
  const construction = vi.fn(tool ? async () => host.capabilities.bindToolSurface([tool]) : create);
  const cleanups: Array<(reason: string) => Promise<void>> = [];
  try {
    await run(
      await buildAgentsApiToolSurface(
        {
          ...attempt,
          hostCapabilities: { ...host.capabilities, createToolSurfaceAsync: construction },
        },
        controller.signal,
        host.capabilities.assertActive,
        (cleanup) => cleanups.push(cleanup),
      ),
      construction,
    );
  } finally {
    if (!tool) {
      controller.abort();
    }
    for (const cleanup of cleanups.toReversed()) {
      await cleanup(tool ? "Tool result test complete" : "Permission test complete");
    }
    host.close();
  }
}

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
    await withSurface(attempt, controller, async (surface, construction) => {
      expect(surface.declarations.map((tool) => tool.name)).toContain("pdf");
      const read = (id: string, file: string) => execute(surface, "pdf", id, { pdf: file });
      // Plain text reaches the real file read but stops before parsing or inference.
      if (permissionMode !== "full") {
        expect(await read("inside", inside)).toMatchObject({
          success: false,
          error: expect.stringContaining("Expected PDF but got"),
        });
      }
      expect(await read("outside", outside)).toMatchObject({
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
    });
  });
});
