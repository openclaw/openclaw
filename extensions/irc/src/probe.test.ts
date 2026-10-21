import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeIrc } from "./probe.js";

const resolveIrcAccountMock = vi.hoisted(() => vi.fn());
const buildIrcConnectOptionsMock = vi.hoisted(() => vi.fn());
const connectIrcClientMock = vi.hoisted(() => vi.fn());
const address = {
  host: "irc.libera.chat",
  port: 6697,
  tls: true,
  nick: "openclaw",
};
const account = { configured: true, ...address };

vi.mock("./accounts.js", () => ({
  resolveIrcAccount: resolveIrcAccountMock,
}));

vi.mock("./connect-options.js", () => ({
  buildIrcConnectOptions: buildIrcConnectOptionsMock,
}));

vi.mock("./client.js", () => ({
  connectIrcClient: connectIrcClientMock,
}));

afterAll(() => {
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./connect-options.js");
  vi.doUnmock("./client.js");
  vi.resetModules();
});

describe("probeIrc", () => {
  beforeEach(() => {
    resolveIrcAccountMock.mockReset();
    buildIrcConnectOptionsMock.mockReset();
    connectIrcClientMock.mockReset();
    resolveIrcAccountMock.mockReturnValue(account);
    buildIrcConnectOptionsMock.mockReturnValue({ host: account.host });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a configuration error when the IRC account is incomplete", async () => {
    const missing = { host: "", port: 6667, tls: false, nick: "" };
    resolveIrcAccountMock.mockReturnValue({ ...missing, configured: false });

    await expect(probeIrc({} as never)).resolves.toEqual({
      ok: false,
      ...missing,
      error: "missing host or nick",
    });
    expect(connectIrcClientMock).not.toHaveBeenCalled();
  });

  it("returns latency and quits the probe client on success", async () => {
    const quit = vi.fn();
    connectIrcClientMock.mockResolvedValue({ quit });
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
    const result = await probeIrc({} as never, { timeoutMs: 5000 });

    expect(buildIrcConnectOptionsMock).toHaveBeenCalledWith(account, { connectTimeoutMs: 5000 });
    expect(result).toEqual({
      ok: true,
      ...address,
      latencyMs: 45,
    });
    expect(quit).toHaveBeenCalledWith("probe");
  });

  it("formats non-Error probe failures into the returned error field", async () => {
    connectIrcClientMock.mockRejectedValue({ code: "ECONNREFUSED" });

    await expect(probeIrc({} as never)).resolves.toEqual({
      ok: false,
      ...address,
      error: JSON.stringify({ code: "ECONNREFUSED" }),
    });
  });
});
