import { setImmediate as tick } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { whatsappApprovalNativeRuntime } from "./approval-handler.runtime.js";
const { presentation, transport, interactions } = whatsappApprovalNativeRuntime;

function approvalContext(id = "exec-1") {
  return {
    cfg: {},
    accountId: "default",
    context: { accountId: "default" },
    request: { id, request: { command: "echo hi" }, createdAtMs: 0, expiresAtMs: 60_000 },
    approvalKind: "exec" as const,
    view: {
      approvalKind: "exec" as const,
      approvalId: id,
      phase: "pending" as const,
      title: "Approval",
      metadata: [],
      commandText: "echo hi",
      actions: [],
      expiresAtMs: 60_000,
    },
    pendingPayload: {
      manualFallbackPayload: { text: "pending" },
      reactionPayload: {
        text: "pending",
        allowedDecisions: ["allow-once" as const],
        reactionBindings: [],
      },
    },
  };
}

const plannedTarget = {
  surface: "origin" as const,
  reason: "preferred" as const,
  target: { to: "15551230000@s.whatsapp.net" },
};

async function finishPending<T>(operation: T | Promise<T>, complete: () => void) {
  let settled = false;
  const pending = Promise.resolve(operation).then((value) => {
    settled = true;
    return value;
  });
  await tick();
  expect(settled).toBe(false);
  complete();
  return pending;
}

describe("whatsappApprovalNativeRuntime", () => {
  it("renders allowed thumbs-only reactions in pending exec approvals", async () => {
    const payload = await presentation.buildPendingPayload({
      ...approvalContext(),
      nowMs: 0,
      view: {
        ...approvalContext().view,
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve exec-1 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve exec-1 deny",
            style: "danger",
          },
        ],
      },
    });

    expect(payload.reactionPayload.text).toContain("👍 Allow Once");
    expect(payload.reactionPayload.text).toContain("👎 Deny");
    expect(payload.reactionPayload.text).not.toContain("1️⃣ Allow Once");
    expect(payload.reactionPayload.text).not.toContain("2️⃣ Allow Always");
    expect(payload.reactionPayload.text).not.toContain("3️⃣ Deny");
    expect(payload.reactionPayload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("normalizes WhatsApp targets and carries account ids into prepared delivery", async () => {
    await expect(
      transport.prepareTarget({
        ...approvalContext(),
        accountId: "ops",
        context: { accountId: "ops" },
        plannedTarget,
      }),
    ).resolves.toEqual({
      dedupeKey: expect.any(String),
      target: { to: "+15551230000", accountId: "ops" },
    });
  });

  it("resolves the configured default account before binding native reactions", async () => {
    await expect(
      transport.prepareTarget({
        cfg: { channels: { whatsapp: { defaultAccount: "work", accounts: { work: {} } } } },
        plannedTarget,
      } as never),
    ).resolves.toEqual({
      dedupeKey: expect.stringContaining("work:"),
      target: { to: "+15551230000", accountId: "work" },
    });
  });
});

it("waits for native reaction binding and cleanup completion", async () => {
  const bindingWrite = createDeferred<null>();
  const cleanupWrite = createDeferred<void>();
  const register = vi
    .spyOn(await import("./approval-reactions.js"), "registerWhatsAppApprovalReactionTarget")
    .mockReturnValue(bindingWrite.promise);
  const unregister = vi
    .spyOn(await import("./approval-reactions.js"), "unregisterWhatsAppApprovalReactionTarget")
    .mockReturnValue(cleanupWrite.promise);
  const entry = {
    accountId: "default",
    to: "+15551230000",
    remoteJid: "15551230000@s.whatsapp.net",
    messageId: "approval-message",
  };
  const context = approvalContext("exec-pending");
  try {
    await expect(
      finishPending(interactions!.bindPending!({ ...context, entry }), () =>
        bindingWrite.resolve(null),
      ),
    ).resolves.toBeNull();
    await finishPending(interactions!.unbindPending!({ ...context, entry, binding: true }), () =>
      cleanupWrite.resolve(),
    );
  } finally {
    bindingWrite.resolve(null);
    cleanupWrite.resolve();
    register.mockRestore();
    unregister.mockRestore();
  }
});
