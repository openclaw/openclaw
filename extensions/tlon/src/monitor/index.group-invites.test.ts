import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { expect, it, vi } from "vitest";
import { useTlonMonitorFixture } from "./monitor.test-harness.js";

const {
  monitorTlonProvider,
  authenticateMock,
  sseClientMock,
  ingressMock,
  settingsManagerMock,
  realUrbitFixture,
} = useTlonMonitorFixture();

it("retires terminal group invites without forgetting unrelated foreigns deltas", async () => {
  vi.useFakeTimers();
  realUrbitFixture.config = {
    channels: {
      tlon: {
        code: "code",
        ship: "~zod",
        url: realUrbitFixture.url,
        autoAcceptGroupInvites: true,
        groupInviteAllowlist: ["~bus"],
      },
    },
  };
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce({});
  const started = Promise.withResolvers<void>();
  ingressMock.start.mockImplementationOnce(() => started.resolve());
  const controller = new AbortController();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
  const monitor = monitorTlonProvider({
    scheduler: createTestPluginServiceScheduler(),
    abortSignal: controller.signal,
    runtime,
  });
  try {
    await Promise.race([started.promise, monitor]);
    const subscription = sseClientMock.subscribe.mock.calls
      .map(([value]) => value)
      .find((value) => value.app === "groups" && value.path === "/v1/foreigns");
    expect(subscription).toBeDefined();
    sseClientMock.poke.mockClear();
    const active = { invites: [{ valid: true, from: "~bus" }] };
    const unrelated = { "~bus/unrelated": active };
    await subscription!.event(unrelated);
    const expectedJoins = ["~bus/unrelated"];
    for (const [state, terminal] of [
      ["revoked", { invites: [{ valid: false, from: "~bus" }] }],
      ["removed", { invites: [] }],
      ["done", { ...active, progress: "done" }],
    ] as const) {
      const groupFlag = `~bus/${state}`;
      const invite = { [groupFlag]: active };
      await subscription!.event(invite);
      expectedJoins.push(groupFlag);
      await subscription!.event(unrelated);
      await subscription!.event(invite);
      await subscription!.event({ [groupFlag]: terminal });
      await subscription!.event(unrelated);
      await subscription!.event(invite);
      expectedJoins.push(groupFlag);
      expect(sseClientMock.poke.mock.calls.map(([call]) => call.json.flag)).toEqual(expectedJoins);
    }
    await subscription!.event({ "~nec/blocked": { invites: [{ valid: true, from: "~nec" }] } });
    expect(sseClientMock.poke.mock.calls).toEqual(
      expectedJoins.map((flag) => [
        { app: "groups", mark: "group-join", json: { flag, "join-all": true } },
      ]),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await monitor;
  }
});
