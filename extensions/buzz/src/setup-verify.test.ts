import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";

const mocks = vi.hoisted(() => ({ callGatewayFromCli: vi.fn() }));
const ROOM_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";

function savedConfigThen(status: unknown) {
  mocks.callGatewayFromCli
    .mockResolvedValueOnce({ appliedConfigHash: "saved", configRevisionHash: "saved" })
    .mockResolvedValueOnce(status);
}

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  callGatewayFromCli: mocks.callGatewayFromCli,
}));

async function verify() {
  const runtime = createRuntimeSpies();
  const { verifyBuzzAfterSetup } = await import("./setup-verify.js");
  await verifyBuzzAfterSetup({ accountId: "default", target: ROOM_ID, runtime });
  return runtime;
}

describe("verifyBuzzAfterSetup", () => {
  beforeEach(() => {
    mocks.callGatewayFromCli.mockReset();
  });

  it("verifies authenticated Buzz membership without sending a message", async () => {
    savedConfigThen({
      channelAccounts: {
        buzz: [{ accountId: "default", probe: { ok: true, rooms: [{ id: ROOM_ID }] } }],
      },
    });
    await verify();

    expect(mocks.callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "channels.status",
    ]);
    expect(mocks.callGatewayFromCli.mock.calls[1]?.[2]).toEqual({
      channel: "buzz",
      probe: true,
      timeoutMs: 10_000,
    });
  });

  it("reports when the authenticated probe is unavailable", async () => {
    savedConfigThen({ channelAccounts: { buzz: [{ accountId: "default" }] } });
    const runtime = await verify();

    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(2);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("did not confirm authenticated membership"),
    );
  });

  it.each([
    {
      message: "gateway closed (1006): no listener",
      expected: "Buzz config was saved. Start OpenClaw to connect: openclaw gateway",
    },
    {
      message: "gateway connection dropped during verification",
      expected: expect.stringContaining("post-setup verification did not complete"),
    },
  ])("reports the appropriate recovery for $message", async ({ message, expected }) => {
    mocks.callGatewayFromCli.mockRejectedValue(
      Object.assign(new Error(message), {
        name: "GatewayTransportError",
        kind: "closed",
        code: 1006,
      }),
    );
    const runtime = await verify();
    expect(runtime.log).toHaveBeenCalledWith(expected);
  });
});
