import { describe, expect, it } from "vitest";
import { FEISHU_CARD_INTERACTION_VERSION } from "./card-interaction.js";
import {
  createExecApprovalCard,
  createExecApprovalResolvedCard,
  FEISHU_EXEC_APPROVAL_ALLOW_ONCE_ACTION,
  FEISHU_EXEC_APPROVAL_ALLOW_ALWAYS_ACTION,
  FEISHU_EXEC_APPROVAL_DENY_ACTION,
} from "./card-ux-exec-approval.js";

describe("createExecApprovalCard", () => {
  it("creates card with three buttons", () => {
    const card = createExecApprovalCard({
      approvalId: "abcdef1234567890",
      command: "rm -rf /tmp/test",
      cwd: "/home/user",
      host: "gateway",
      expiresAtMs: Date.now() + 120_000,
    });

    expect(card.schema).toBe("2.0");
    expect((card.header as Record<string, unknown>).template).toBe("orange");

    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect(body.elements).toHaveLength(2);

    const markdownElement = body.elements[0];
    expect(markdownElement.tag).toBe("markdown");
    expect(markdownElement.content).toContain("abcdef12");
    expect(markdownElement.content).toContain("rm -rf /tmp/test");
    expect(markdownElement.content).toContain("/home/user");

    const actionElement = body.elements[1] as { actions: Array<Record<string, unknown>> };
    expect(actionElement.actions).toHaveLength(3);

    const allowOnceButton = actionElement.actions[0];
    expect((allowOnceButton.text as Record<string, string>).content).toBe("Allow Once");
    expect(allowOnceButton.type).toBe("primary");
    const allowOnceValue = allowOnceButton.value as Record<string, unknown>;
    expect(allowOnceValue.oc).toBe(FEISHU_CARD_INTERACTION_VERSION);
    expect(allowOnceValue.a).toBe(FEISHU_EXEC_APPROVAL_ALLOW_ONCE_ACTION);
    expect((allowOnceValue.m as Record<string, string>).approvalId).toBe("abcdef1234567890");

    const allowAlwaysButton = actionElement.actions[1];
    expect((allowAlwaysButton.text as Record<string, string>).content).toBe("Allow Always");
    expect(allowAlwaysButton.type).toBe("default");
    expect((allowAlwaysButton.value as Record<string, unknown>).a).toBe(
      FEISHU_EXEC_APPROVAL_ALLOW_ALWAYS_ACTION,
    );

    const denyButton = actionElement.actions[2];
    expect((denyButton.text as Record<string, string>).content).toBe("Deny");
    expect(denyButton.type).toBe("danger");
    expect((denyButton.value as Record<string, unknown>).a).toBe(FEISHU_EXEC_APPROVAL_DENY_ACTION);
  });

  it("omits optional fields when not provided", () => {
    const card = createExecApprovalCard({
      approvalId: "test123",
      command: "echo hello",
      expiresAtMs: Date.now() + 60_000,
    });

    const body = card.body as { elements: Array<Record<string, unknown>> };
    const content = body.elements[0].content as string;
    expect(content).not.toContain("CWD");
    expect(content).not.toContain("Host");
  });
});

describe("createExecApprovalResolvedCard", () => {
  it("creates green card for allow-once", () => {
    const card = createExecApprovalResolvedCard({
      approvalId: "abcdef1234567890",
      decision: "allow-once",
    });

    expect((card.header as Record<string, unknown>).template).toBe("green");
    const title = (card.header as Record<string, Record<string, string>>).title;
    expect(title.content).toContain("Allowed (once)");
  });

  it("creates green card for allow-always", () => {
    const card = createExecApprovalResolvedCard({
      approvalId: "test123",
      decision: "allow-always",
    });

    expect((card.header as Record<string, unknown>).template).toBe("green");
    const title = (card.header as Record<string, Record<string, string>>).title;
    expect(title.content).toContain("Allowed (always)");
  });

  it("creates red card for deny", () => {
    const card = createExecApprovalResolvedCard({
      approvalId: "test123",
      decision: "deny",
    });

    expect((card.header as Record<string, unknown>).template).toBe("red");
    const title = (card.header as Record<string, Record<string, string>>).title;
    expect(title.content).toContain("Denied");
  });

  it("includes resolvedBy when provided", () => {
    const card = createExecApprovalResolvedCard({
      approvalId: "test123",
      decision: "allow-once",
      resolvedBy: "user@feishu",
    });

    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect(body.elements[0].content).toContain("user@feishu");
  });
});
