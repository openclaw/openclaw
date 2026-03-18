import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const resolveExecApprovalTimeoutMsMock = vi.hoisted(() => vi.fn());

let buildDefaultExecApprovalRequestArgs: typeof import("./bash-tools.exec-host-shared.js").buildDefaultExecApprovalRequestArgs;

describe("buildDefaultExecApprovalRequestArgs", () => {
  beforeEach(async () => {
    vi.resetModules();
    loadConfigMock.mockReset();
    resolveExecApprovalTimeoutMsMock.mockReset();
    resolveExecApprovalTimeoutMsMock.mockReturnValue(600_000);

    vi.doMock("../config/config.js", () => ({
      loadConfig: (...args: unknown[]) => loadConfigMock(...args),
    }));
    vi.doMock("../infra/exec-approval-surface.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../infra/exec-approval-surface.js")>();
      return {
        ...actual,
        resolveExecApprovalTimeoutMs: (...args: unknown[]) =>
          resolveExecApprovalTimeoutMsMock(...args),
      };
    });

    ({ buildDefaultExecApprovalRequestArgs } = await import("./bash-tools.exec-host-shared.js"));
  });

  it("lets surface timeout resolution load config lazily", () => {
    const createApprovalSlug = (approvalId: string) => approvalId;

    expect(
      buildDefaultExecApprovalRequestArgs({
        warnings: [],
        timeoutMs: 120_000,
        approvalRunningNoticeMs: 10_000,
        createApprovalSlug,
        turnSourceChannel: "web",
        turnSourceAccountId: "main",
      }),
    ).toEqual({
      warnings: [],
      timeoutMs: 600_000,
      approvalRunningNoticeMs: 10_000,
      createApprovalSlug,
      turnSourceChannel: "web",
      turnSourceAccountId: "main",
    });

    expect(resolveExecApprovalTimeoutMsMock).toHaveBeenCalledWith({
      channel: "web",
      accountId: "main",
      defaultTimeoutMs: 120_000,
    });
    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});
