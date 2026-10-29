import assert from "node:assert/strict";
import { createLazyChannelApprovalNativeRuntimeAdapterAsync } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import { createChannelApprovalHandlerFromCapability } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ExecApprovalActionDescriptor } from "openclaw/plugin-sdk/approval-reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { parseExecApprovalData } from "./approval-custom-id.js";
import { discordApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { parseCustomId } from "./internal/components.base.js";

const handlerContext = {
  cfg: {},
  accountId: "main",
  context: { token: "discord-token", config: {} },
};
type ApprovalRequest = Parameters<
  typeof discordApprovalNativeRuntime.presentation.buildPendingPayload
>[0]["request"];
function request<T extends ApprovalRequest["request"]>(id: string, data: T, expiresAtMs = 1_000) {
  return { id, request: data, createdAtMs: 0, expiresAtMs };
}
function approvalAction(decision: "allow-once" | "deny"): ExecApprovalActionDescriptor {
  return {
    label: decision === "deny" ? "Deny" : "Allow",
    decision,
    style: decision === "deny" ? "danger" : "success",
    command: "/approve",
  };
}

async function buildExecApprovalPayloadText(commandText: string): Promise<string> {
  const pending = await discordApprovalNativeRuntime.presentation.buildPendingPayload({
    ...handlerContext,
    request: request("approval-1", { command: commandText }),
    approvalKind: "exec",
    nowMs: 0,
    view: {
      approvalKind: "exec",
      phase: "pending",
      approvalId: "approval-1",
      title: "Exec Approval Required",
      commandText,
      expiresAtMs: 1_000,
      metadata: [],
      actions: [approvalAction("allow-once")],
    },
  });
  expect(pending.body).not.toHaveProperty("nonce");
  expect(pending.body).not.toHaveProperty("enforce_nonce");
  return JSON.stringify(pending);
}

async function buildPluginApprovalPayloadText(params?: {
  severity?: "info" | "warning" | "critical";
  expiresAtMs?: number;
}): Promise<string> {
  const expiresAtMs = params?.expiresAtMs ?? 1_000;
  const pending = await discordApprovalNativeRuntime.presentation.buildPendingPayload({
    ...handlerContext,
    request: request(
      "plain-plugin-id",
      { title: "Install plugin", description: "Approve the requested plugin" },
      expiresAtMs,
    ),
    approvalKind: "plugin",
    nowMs: 0,
    view: {
      approvalKind: "plugin",
      phase: "pending",
      approvalId: "plain-plugin-id",
      title: "Install plugin",
      description: "Approve the requested plugin",
      severity: params?.severity ?? "warning",
      metadata: [],
      actions: [approvalAction("deny")],
      expiresAtMs,
    },
  } as never);
  return JSON.stringify(pending);
}

describe("discordApprovalNativeRuntime", () => {
  it.each([
    { phase: "resolved", cleanup: true, deleteStatus: 204, editStatus: 200, methods: ["DELETE"] },
    {
      phase: "resolved",
      cleanup: true,
      deleteStatus: 404,
      editStatus: 200,
      methods: ["DELETE", "PATCH"],
    },
    { phase: "expired", cleanup: true, deleteStatus: 204, editStatus: 200, methods: ["PATCH"] },
    { phase: "resolved", cleanup: false, deleteStatus: 204, editStatus: 403, methods: ["PATCH"] },
  ] as const)(
    "finalizes $phase approvals with cleanup=$cleanup and DELETE=$deleteStatus/PATCH=$editStatus",
    async ({ phase, cleanup, deleteStatus, editStatus, methods }) => {
      const container = { type: 17, components: [{ type: 10, content: "Approved" }] };
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        const status = init?.method === "DELETE" ? deleteStatus : editStatus;
        return status === 204
          ? new Response(null, { status })
          : Response.json(status === 200 ? { id: "456" } : { message: "Unavailable" }, { status });
      });
      try {
        await expect(
          discordApprovalNativeRuntime.transport.updateEntry?.({
            ...handlerContext,
            context: { token: "discord-token", config: { cleanupAfterResolve: cleanup } },
            request: request("approval-1", { command: "hostname" }),
            approvalKind: "exec",
            entry: { discordChannelId: "123", discordMessageId: "456" },
            payload: container,
            phase,
          }),
        ).resolves.toBeUndefined();
        expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(methods);
        for (const [url, init] of fetch.mock.calls) {
          expect(url).toBe("https://discord.com/api/v10/channels/123/messages/456");
          if (init?.method === "PATCH") {
            expect(typeof init.body).toBe("string");
            expect(JSON.parse(typeof init.body === "string" ? init.body : "{}")).toMatchObject({
              components: [container],
              allowed_mentions: { parse: [] },
            });
          }
        }
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it("encodes the explicit owner kind in exec and plugin approval buttons", async () => {
    const execPayload = await buildExecApprovalPayloadText("hostname");
    expect(execPayload).toContain("execapproval:kind=exec;id=approval-1;action=allow-once");
    expect(execPayload).toContain('"allowed_mentions":{"parse":[]}');
    await expect(buildPluginApprovalPayloadText()).resolves.toContain(
      "execapproval:kind=plugin;id=plain-plugin-id;action=deny",
    );
  });

  it("round-trips system-agent buttons emitted by the native approval handler", async () => {
    const buildPendingPayload = vi.fn(
      discordApprovalNativeRuntime.presentation.buildPendingPayload,
    );
    const handler = await createChannelApprovalHandlerFromCapability({
      label: "discord/approval-test",
      clientDisplayName: "Discord approval test",
      channel: "discord",
      channelLabel: "Discord",
      ...handlerContext,
      nowMs: () => 0,
      capability: {
        nativeRuntimeAsync: createLazyChannelApprovalNativeRuntimeAdapterAsync({
          capabilityBoundary: true,
          eventKinds: discordApprovalNativeRuntime.eventKinds,
          isConfigured: () => true,
          shouldHandle: () => true,
          load: async () => ({
            ...discordApprovalNativeRuntime,
            presentation: { ...discordApprovalNativeRuntime.presentation, buildPendingPayload },
          }),
        }),
      },
    });
    assert(handler);
    try {
      await handler.handleRequested(
        request("change-1", {
          title: "Apply proposed change",
          description: "Rewrite the scheduler.",
          command: "rewrite scheduler",
          proposalHash: "hash-1",
          sessionId: "session-1",
          allowedDecisions: ["allow-once", "deny"],
        }),
      );
      expect(buildPendingPayload).toHaveBeenCalledOnce();
      const pending = await buildPendingPayload.mock.results[0]?.value;
      const customIds: string[] = [];
      JSON.stringify(pending, (key, value: unknown) => {
        if (key === "custom_id" && typeof value === "string") {
          customIds.push(value);
        }
        return value;
      });
      expect(customIds.map((id) => parseExecApprovalData(parseCustomId(id).data))).toEqual([
        { approvalId: "change-1", approvalKind: "system-agent", action: "allow-once" },
        { approvalId: "change-1", approvalKind: "system-agent", action: "deny" },
      ]);
    } finally {
      await handler.stop();
    }
  });

  it.each([
    { severity: "info" as const, accentColor: 0x5865f2 },
    { severity: "critical" as const, accentColor: 0xed4245 },
  ])("preserves $severity plugin approval styling and clamps expiry", async (params) => {
    const payload = await buildPluginApprovalPayloadText({
      severity: params.severity,
      expiresAtMs: -1,
    });

    expect(payload).toContain(`"accent_color":${params.accentColor}`);
    expect(payload).toContain("Expires <t:0:R>");
  });

  it.each([
    ["exec", "resolved", "allow-once", "Allowed (once)", 0x57f287],
    ["exec", "resolved", "allow-always", "Allowed (always)", 0x5865f2],
    ["system-agent", "resolved", "deny", "Denied", 0xed4245],
    ["exec", "expired", undefined, "Expired", 0x99aab5],
  ] as const)(
    "preserves %s %s approval components and terminal preview limits (%s)",
    async (approvalKind, phase, decision, label, accentColor) => {
      const systemAgent = approvalKind === "system-agent";
      const commandLimit = 500;
      const secondaryLimit = 300;
      const command = `${"x".repeat(commandLimit)}😀`;
      const secondary = `${"y".repeat(secondaryLimit)}😀`;
      const view = {
        approvalId: "approval-<@123>",
        approvalKind,
        phase,
        title: "Exec Approval Required",
        metadata: [{ label: "agent", value: "crew" }],
        commandText: command,
        commandPreview: secondary,
        ...(phase === "resolved" ? { decision, resolvedBy: "<@456>" } : {}),
        ...(systemAgent
          ? {
              operationSummary: command,
              applicationStatus: "not-applied",
            }
          : {}),
      };
      const args = {
        ...handlerContext,
        view,
      };
      const result =
        phase === "resolved"
          ? await discordApprovalNativeRuntime.presentation.buildResolvedResult(args as never)
          : await discordApprovalNativeRuntime.presentation.buildExpiredResult(args as never);

      assert(result.kind === "update");
      const container = result.payload;
      expect(container).toMatchObject({
        type: 17,
        accent_color: accentColor,
        components: expect.arrayContaining(
          [
            `## ${systemAgent ? "OpenClaw Change" : "Exec"} Approval: ${label}`,
            `### ${systemAgent ? "Change" : "Command"}\n\`\`\`\n${"x".repeat(commandLimit)}...\n\`\`\``,
            `### Shell Preview\n\`\`\`\n${"y".repeat(secondaryLimit)}...\n\`\`\``,
            "- agent: crew",
            "-# ID: approval\\-\\<@123\\>",
            phase === "resolved" ? "Resolved by \\<@456\\>" : "This approval request has expired.",
          ].map((content) => ({ content, type: 10 })),
        ),
      });
      expect(JSON.stringify(container)).not.toContain("custom_id");
    },
  );

  it("does not split emoji graphemes when truncating exec command previews", async () => {
    const prefix = "a".repeat(999);

    await expect(buildExecApprovalPayloadText(`${prefix}😀x`)).resolves.toContain(`${prefix}...`);
    await expect(buildExecApprovalPayloadText(`${prefix}🇺🇸x`)).resolves.toContain(`${prefix}...`);
  });

  it("routes origin approval updates to the Discord thread channel when threadId is present", async () => {
    const prepared = await discordApprovalNativeRuntime.transport.prepareTarget({
      ...handlerContext,
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: {
          to: "123456789",
          threadId: "777888999",
        },
      },
      request: request("req-1", { command: "hostname" }),
      approvalKind: "exec",
      view: {} as never,
      pendingPayload: {} as never,
    });

    expect(prepared).toEqual({
      dedupeKey: "777888999",
      target: {
        discordChannelId: "777888999",
      },
    });
  });
});
