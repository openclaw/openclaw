import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { expect, it, vi } from "vitest";
import { useTlonMonitorFixture } from "./monitor.test-harness.js";

const {
  monitorTlonProvider,
  authenticateMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
  realUrbitFixture,
} = useTlonMonitorFixture();

it("fetches and prepends citations only after DM and channel sender admission", async () => {
  vi.useFakeTimers();
  const nest = "chat/~zod/citations";
  const content = [
    { block: { cite: { chan: { nest, where: "/msg/~bus/12345" } } } },
    { inline: ["~zod inspect this citation"] },
  ];
  realUrbitFixture.config = {
    channels: {
      tlon: {
        code: "code",
        ship: "~zod",
        url: realUrbitFixture.url,
        dmAllowlist: ["~bus"],
        defaultAuthorizedShips: ["~bus"],
        groupChannels: [nest],
      },
    },
  };
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce({});
  ingressMock.receive.mockResolvedValue({ kind: "ignored" });
  const started = Promise.withResolvers<void>();
  ingressMock.start.mockImplementationOnce(() => started.resolve());
  const controller = new AbortController();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
  const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
  try {
    await Promise.race([started.promise, monitor]);
    for (const source of ["chat", "channels"]) {
      const subscription = sseClientMock.subscribe.mock.calls
        .map(([value]) => value)
        .find((value) => value.app === source);
      expect(subscription).toBeDefined();
      for (const sender of ["~nec", "~bus"]) {
        sseClientMock.scry.mockReset().mockResolvedValue({
          essay: { content: [{ inline: ["CITED-CONTENT"] }] },
        });
        inboundRuntimeMock.buildContext.mockClear();
        inboundRuntimeMock.dispatch.mockClear();
        const essay = { author: sender, content, sent: 1_700_000_000_000 };
        const id = `${source}-${sender}`;
        await subscription!.event(
          source === "chat"
            ? { whom: sender, id, response: { add: { essay } } }
            : { nest, response: { post: { id, "r-post": { set: { essay } } } } },
        );
        if (sender === "~nec") {
          expect(sseClientMock.scry).not.toHaveBeenCalled();
          expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
        } else {
          expect(sseClientMock.scry).toHaveBeenCalledExactlyOnceWith(
            `/channels/v4/${nest}/posts/post/12345.json`,
          );
          expect(inboundRuntimeMock.buildContext.mock.calls[0]?.[0].message.rawBody).toBe(
            `> ~bus wrote: CITED-CONTENT\n\n> [quoted: ~bus in ${nest}]\n\n~zod inspect this citation`,
          );
          expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
        }
      }
    }
    expect(runtime.error).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await monitor;
  }
});
