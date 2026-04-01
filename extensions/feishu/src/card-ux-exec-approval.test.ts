import { describe, expect, it } from "vitest";
import { FEISHU_CARD_INTERACTION_VERSION } from "./card-interaction.js";
import {
  createExecApprovalCard,
  createExecApprovalResolvedCard,
  FEISHU_EXEC_APPROVAL_ALLOW_ONCE_ACTION,
  FEISHU_EXEC_APPROVAL_ALLOW_ALWAYS_ACTION,
  FEISHU_EXEC_APPROVAL_DENY_ACTION,
} from "./card-ux-exec-approval.js";

function extractButtons(card: Record<string, unknown>) {
  const body = card.body as { elements: Array<Record<string, unknown>> };
  const columnSet = body.elements[1] as {
    columns: Array<{ elements: Array<Record<string, unknown>> }>;
  };
  return columnSet.columns.map((col) => col.elements[0]);
}

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

    const buttons = extractButtons(card);
    expect(buttons).toHaveLength(3);

    const allowOnceButton = buttons[0];
    expect((allowOnceButton.text as Record<string, string>).content).toBe("允许一次");
    expect(allowOnceButton.type).toBe("primary");
    const allowOnceValue = allowOnceButton.value as Record<string, unknown>;
    expect(allowOnceValue.oc).toBe(FEISHU_CARD_INTERACTION_VERSION);
    expect(allowOnceValue.a).toBe(FEISHU_EXEC_APPROVAL_ALLOW_ONCE_ACTION);
    expect((allowOnceValue.m as Record<string, string>).approvalId).toBe("abcdef1234567890");
    expect((allowOnceValue.m as Record<string, string>).command).toBe("rm -rf /tmp/test");
    expect((allowOnceValue.m as Record<string, string>).cwd).toBe("/home/user");
    const allowOnceContext = allowOnceValue.c as Record<string, unknown>;
    expect(allowOnceContext.e).toBeTypeOf("number");
    expect(allowOnceContext.u).toBeUndefined();

    const allowAlwaysButton = buttons[1];
    expect((allowAlwaysButton.text as Record<string, string>).content).toBe("始终允许");
    expect(allowAlwaysButton.type).toBe("default");
    expect((allowAlwaysButton.value as Record<string, unknown>).a).toBe(
      FEISHU_EXEC_APPROVAL_ALLOW_ALWAYS_ACTION,
    );

    const denyButton = buttons[2];
    expect((denyButton.text as Record<string, string>).content).toBe("拒绝");
    expect(denyButton.type).toBe("danger");
    expect((denyButton.value as Record<string, unknown>).a).toBe(FEISHU_EXEC_APPROVAL_DENY_ACTION);
  });

  it("includes chatType in button context when provided", () => {
    const card = createExecApprovalCard({
      approvalId: "abcdef1234567890",
      command: "ls",
      expiresAtMs: Date.now() + 60_000,
      chatType: "group",
    });
    const buttons = extractButtons(card);
    const buttonValue = buttons[0].value as Record<string, unknown>;
    const context = buttonValue.c as Record<string, unknown>;
    expect(context.t).toBe("group");
  });

  it("omits optional fields when not provided", () => {
    const card = createExecApprovalCard({
      approvalId: "test123",
      command: "echo hello",
      expiresAtMs: Date.now() + 60_000,
    });

    const body = card.body as { elements: Array<Record<string, unknown>> };
    const content = body.elements[0].content as string;
    expect(content).not.toContain("工作目录");
    expect(content).not.toContain("主机");
  });
});

describe("createExecApprovalResolvedCard", () => {
  it("creates green card for allow-once with command info", () => {
    const card = createExecApprovalResolvedCard({
      approvalId: "abcdef1234567890",
      decision: "allow-once",
      command: "rm -rf /tmp/test",
      cwd: "/home/user",
    });

    expect((card.header as Record<string, unknown>).template).toBe("green");
    const title = (card.header as Record<string, Record<string, string>>).title;
    expect(title.content).toContain("已允许（一次）");

    const body = card.body as { elements: Array<Record<string, unknown>> };
    const content = body.elements[0].content as string;
    expect(content).toContain("rm -rf /tmp/test");
    expect(content).toContain("/home/user");
  });

  it("creates green card for allow-always", () => {
    const card = createExecApprovalResolvedCard({
      approvalId: "test123",
      decision: "allow-always",
    });

    expect((card.header as Record<string, unknown>).template).toBe("green");
    const title = (card.header as Record<string, Record<string, string>>).title;
    expect(title.content).toContain("已允许（始终）");
  });

  it("creates red card for deny", () => {
    const card = createExecApprovalResolvedCard({
      approvalId: "test123",
      decision: "deny",
    });

    expect((card.header as Record<string, unknown>).template).toBe("red");
    const title = (card.header as Record<string, Record<string, string>>).title;
    expect(title.content).toContain("已拒绝");
  });

  it("includes resolvedBy when provided", () => {
    const card = createExecApprovalResolvedCard({
      approvalId: "test123",
      decision: "allow-once",
      resolvedBy: "user@feishu",
    });

    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect(body.elements[0].content).toContain('<at id="user@feishu"></at>');
  });

  it("omits command and cwd when not provided", () => {
    const card = createExecApprovalResolvedCard({
      approvalId: "test123",
      decision: "deny",
    });

    const body = card.body as { elements: Array<Record<string, unknown>> };
    const content = body.elements[0].content as string;
    expect(content).not.toContain("命令");
    expect(content).not.toContain("工作目录");
  });
});
