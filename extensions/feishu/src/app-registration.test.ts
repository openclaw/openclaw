// Feishu tests cover app registration plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
<<<<<<< HEAD
import { beginAppRegistration, pollAppRegistration, printQrCode } from "./app-registration.js";

const { fetchWithSsrFGuardMock, renderQrTerminalMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  renderQrTerminalMock: vi.fn(async () => "terminal-qr"),
=======
import { beginAppRegistration, pollAppRegistration } from "./app-registration.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

<<<<<<< HEAD
vi.mock("./qr-terminal.js", () => ({
  renderQrTerminal: renderQrTerminalMock,
}));

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
function mockFeishuJson(payload: unknown) {
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(JSON.stringify(payload), { status: 200 }),
    release: async () => {},
  });
}

describe("Feishu app registration", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fetchWithSsrFGuardMock.mockReset();
<<<<<<< HEAD
    renderQrTerminalMock.mockClear();
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("defaults unsafe begin polling lifetimes from provider responses", async () => {
    mockFeishuJson({
      device_code: "device-code",
      verification_uri_complete: "https://accounts.feishu.cn/verify?x=1",
      user_code: "user-code",
      interval: Number.POSITIVE_INFINITY,
      expire_in: Number.POSITIVE_INFINITY,
    });

    await expect(beginAppRegistration()).resolves.toMatchObject({
      deviceCode: "device-code",
      userCode: "user-code",
      interval: 5,
      expireIn: 600,
    });
  });

  it("clamps unsafe poll sleeps from provider intervals", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("transient"));

    const poll = pollAppRegistration({
      deviceCode: "device-code",
      interval: 10_000_000,
      expireIn: 10_000_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

    await vi.runOnlyPendingTimersAsync();
    await expect(poll).resolves.toEqual({ status: "timeout" });
  });
<<<<<<< HEAD

  it("prints scan-to-create QR codes with compact terminal rendering", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await printQrCode("https://accounts.feishu.cn/verify?device_code=long-device-code");

    expect(renderQrTerminalMock).toHaveBeenCalledWith(
      "https://accounts.feishu.cn/verify?device_code=long-device-code",
      { small: true },
    );
    expect(writeSpy).toHaveBeenCalledWith("terminal-qr\n");
  });
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
});
