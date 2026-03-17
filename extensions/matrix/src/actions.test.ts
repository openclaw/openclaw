import type { ChannelMessageActionContext, OpenClawConfig } from "openclaw/plugin-sdk/matrix";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleMatrixAction: vi.fn(),
  resolveMatrixAccount: vi.fn(),
}));

vi.mock("./tool-actions.js", () => ({
  handleMatrixAction: mocks.handleMatrixAction,
}));

vi.mock("./matrix/accounts.js", () => ({
  resolveMatrixAccount: mocks.resolveMatrixAccount,
}));

import { matrixMessageActions } from "./actions.js";

const baseCfg = { channels: { matrix: {} } } as OpenClawConfig;

function makeCtx(
  overrides: Partial<ChannelMessageActionContext> = {},
): ChannelMessageActionContext {
  return {
    channel: "matrix",
    action: "send",
    cfg: baseCfg,
    params: {},
    ...overrides,
  };
}

describe("matrixMessageActions.handleAction accountId threading", () => {
  beforeEach(() => {
    mocks.handleMatrixAction.mockReset();
    mocks.handleMatrixAction.mockResolvedValue({ ok: true });
  });

  it("passes accountId from ctx to handleMatrixAction for send", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx({
        action: "send",
        accountId: "stella",
        params: { to: "room:!abc:example", message: "hello" },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledOnce();
    const [, , accountId] = mocks.handleMatrixAction.mock.calls[0];
    expect(accountId).toBe("stella");
  });

  it("passes undefined when accountId is null", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx({
        action: "send",
        accountId: null,
        params: { to: "room:!abc:example", message: "hello" },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledOnce();
    const [, , accountId] = mocks.handleMatrixAction.mock.calls[0];
    expect(accountId).toBeUndefined();
  });

  it("passes undefined when accountId is omitted", async () => {
    await matrixMessageActions.handleAction!(
      makeCtx({
        action: "send",
        params: { to: "room:!abc:example", message: "hello" },
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledOnce();
    const [, , accountId] = mocks.handleMatrixAction.mock.calls[0];
    expect(accountId).toBeUndefined();
  });
});
