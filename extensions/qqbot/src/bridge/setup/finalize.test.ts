import { describe, expect, it, vi } from "vitest";

const qrConnect = vi.hoisted(() => vi.fn());
const connectorModuleState = vi.hoisted(() => ({ loaded: false }));

vi.mock("@tencent-connect/qqbot-connector", () => {
  connectorModuleState.loaded = true;
  return { qrConnect };
});

import { registerPlatformAdapter } from "../../engine/adapter/index.js";
import { finalizeQQBotSetup } from "./finalize.js";

registerPlatformAdapter({
  hasConfiguredSecret: () => false,
} as never);

function createParams(beforePersistentEffect: () => Promise<void>) {
  return {
    cfg: {},
    accountId: "default",
    forceAllowFrom: false,
    prompter: {
      note: vi.fn(async () => {}),
      select: vi.fn(async () => "qr"),
    },
    runtime: {
      error: vi.fn(),
      log: vi.fn(),
    },
    options: { beforePersistentEffect },
  } as never;
}

describe("QQ Bot setup persistent effects", () => {
  it("revalidates immediately before starting QR binding", async () => {
    qrConnect.mockReset();
    qrConnect.mockResolvedValue([{ appId: "qq-app", appSecret: "qq-secret" }]);
    expect(connectorModuleState.loaded).toBe(false);
    const beforePersistentEffect = vi.fn(async () => {
      expect(connectorModuleState.loaded).toBe(true);
    });

    const result = await finalizeQQBotSetup(createParams(beforePersistentEffect));

    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(qrConnect).toHaveBeenCalledWith({ source: "openclaw" });
    expect(beforePersistentEffect.mock.invocationCallOrder[0]).toBeLessThan(
      qrConnect.mock.invocationCallOrder[0]!,
    );
    expect(result.cfg.channels?.qqbot?.appId).toBe("qq-app");
  });

  it("propagates a stale inference guard outside the QR binding catch", async () => {
    qrConnect.mockReset();
    const guardError = new Error("verified inference changed");
    const beforePersistentEffect = vi.fn(async () => {
      throw guardError;
    });
    const params = createParams(beforePersistentEffect);

    await expect(finalizeQQBotSetup(params)).rejects.toBe(guardError);

    expect(qrConnect).not.toHaveBeenCalled();
    expect(params.runtime.error).not.toHaveBeenCalled();
  });
});
