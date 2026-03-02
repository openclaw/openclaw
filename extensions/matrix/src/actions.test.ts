/**
 * Regression tests: matrixMessageActions.handleAction must forward ctx.accountId
 * (server-injected binding account) to every underlying action.
 *
 * Before fix: actions.ts built a new params object without forwarding ctx.accountId,
 * so handleMatrixAction always received accountId=undefined → resolveMatrixClient
 * fell back to the first client in the Map → wrong account → M_FORBIDDEN.
 *
 * This is the Hop 0 bug: above the tool-actions.ts hop we already fixed.
 * Discord's handle-action.ts has this right; Matrix was missing it.
 *
 * See: openclaw/openclaw#26457
 */
import type { ChannelMessageActionContext, OpenClawConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — factories must not reference outer variables
vi.mock("./tool-actions.js", () => ({
  handleMatrixAction: vi.fn().mockResolvedValue({ type: "json", value: { ok: true } }),
}));

vi.mock("./matrix/accounts.js", () => ({
  resolveMatrixAccount: vi.fn().mockReturnValue({ enabled: true, configured: true }),
}));

import { matrixMessageActions } from "./actions.js";
import * as toolActionsModule from "./tool-actions.js";

const handleMatrixActionMock = vi.mocked(toolActionsModule.handleMatrixAction);

const cfg = {} as OpenClawConfig;

function makeCtx(
  action: ChannelMessageActionContext["action"],
  params: Record<string, unknown>,
  accountId?: string,
): ChannelMessageActionContext {
  return {
    channel: "matrix",
    action,
    cfg,
    params,
    accountId: accountId ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("matrixMessageActions.handleAction — ctx.accountId forwarding", () => {
  it("send: forwards ctx.accountId to handleMatrixAction", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx("send", { to: "!room:matrix.org", message: "hi" }, "neko"),
    );

    expect(handleMatrixActionMock).toHaveBeenCalledOnce();
    expect(handleMatrixActionMock.mock.calls[0][0]).toMatchObject({ accountId: "neko" });
  });

  it("send: accountId is undefined when ctx.accountId is null (no regression for single-account)", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx("send", { to: "!room:matrix.org", message: "hi" }),
    );

    expect(handleMatrixActionMock).toHaveBeenCalledOnce();
    const passedParams = handleMatrixActionMock.mock.calls[0][0];
    expect(passedParams.accountId == null).toBe(true);
  });

  it("react: forwards ctx.accountId", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx("react", { to: "!room:matrix.org", messageId: "$evt1", emoji: "👍" }, "neko"),
    );

    expect(handleMatrixActionMock).toHaveBeenCalledOnce();
    expect(handleMatrixActionMock.mock.calls[0][0]).toMatchObject({ accountId: "neko" });
  });

  it("reactions: forwards ctx.accountId", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx("reactions", { to: "!room:matrix.org", messageId: "$evt1" }, "neko"),
    );

    expect(handleMatrixActionMock).toHaveBeenCalledOnce();
    expect(handleMatrixActionMock.mock.calls[0][0]).toMatchObject({ accountId: "neko" });
  });

  it("read: forwards ctx.accountId", async () => {
    await matrixMessageActions.handleAction!(makeCtx("read", { to: "!room:matrix.org" }, "neko"));

    expect(handleMatrixActionMock).toHaveBeenCalledOnce();
    expect(handleMatrixActionMock.mock.calls[0][0]).toMatchObject({ accountId: "neko" });
  });

  it("edit: forwards ctx.accountId", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx("edit", { to: "!room:matrix.org", messageId: "$evt1", message: "updated" }, "neko"),
    );

    expect(handleMatrixActionMock).toHaveBeenCalledOnce();
    expect(handleMatrixActionMock.mock.calls[0][0]).toMatchObject({ accountId: "neko" });
  });

  it("delete: forwards ctx.accountId", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx("delete", { to: "!room:matrix.org", messageId: "$evt1" }, "neko"),
    );

    expect(handleMatrixActionMock).toHaveBeenCalledOnce();
    expect(handleMatrixActionMock.mock.calls[0][0]).toMatchObject({ accountId: "neko" });
  });

  it("pin: forwards ctx.accountId", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx("pin", { to: "!room:matrix.org", messageId: "$evt1" }, "neko"),
    );

    expect(handleMatrixActionMock).toHaveBeenCalledOnce();
    expect(handleMatrixActionMock.mock.calls[0][0]).toMatchObject({ accountId: "neko" });
  });

  it("unpin: forwards ctx.accountId", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx("unpin", { to: "!room:matrix.org", messageId: "$evt1" }, "neko"),
    );

    expect(handleMatrixActionMock).toHaveBeenCalledOnce();
    expect(handleMatrixActionMock.mock.calls[0][0]).toMatchObject({ accountId: "neko" });
  });

  it("list-pins: forwards ctx.accountId", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx("list-pins", { to: "!room:matrix.org" }, "neko"),
    );

    expect(handleMatrixActionMock).toHaveBeenCalledOnce();
    expect(handleMatrixActionMock.mock.calls[0][0]).toMatchObject({ accountId: "neko" });
  });
});
