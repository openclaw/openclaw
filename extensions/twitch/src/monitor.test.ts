import { join } from "node:path";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { withTwitchMonitor } from "./monitor-access.test-support.js";
import { BASE_TWITCH_TEST_ACCOUNT } from "./test-fixtures.js";

type DeliveryCase = [string, ReplyPayload, string | undefined, boolean, string?, string?];
const account = { ...BASE_TWITCH_TEST_ACCOUNT, accessToken: "oauth:test-token" };
const image = "https://example.com/a";
const files = [image, "https://example.com/b"];
const sessionDirs = useSessionStoreTempDirs(afterAll, "twitch-delivery-");

describe("Twitch monitor delivery", () => {
  it.each<DeliveryCase>([
    ["Markdown", { text: "**Hello** Twitch" }, "Hello Twitch", true],
    ["legacy media caption", { text: "See:", mediaUrl: image }, `See: ${image}`, true],
    ["all attachments", { text: "Files:", mediaUrls: files }, `Files: ${files.join(" ")}`, true],
    ["media only", { mediaUrl: image }, image, true],
    ["empty", { text: "" }, undefined, false, undefined, "No text to send in reply payload"],
    [
      "send failure",
      { text: "Hi" },
      "Hi",
      false,
      "unavailable",
      "Failed to send reply: Error: unavailable",
    ],
  ])("handles %s", async (_name, payload, expectedText, visible, providerError, expectedError) => {
    const config = { session: { store: join(sessionDirs.make(), "sessions.json") } };
    const statusSink = vi.fn();
    const completed = await withTwitchMonitor(
      { account, accountId: "default", config, statusSink },
      async (fixture) => {
        const { core, send, error, dispatch } = fixture;
        if (providerError) {
          send.mockResolvedValueOnce({ ok: false, error: providerError });
        }
        vi.mocked(core.channel.routing.resolveAgentRoute).mockReturnValue({
          agentId: "main",
          channel: "twitch",
          accountId: "default",
          sessionKey: "agent:main:twitch:group:testchannel",
          mainSessionKey: "agent:main:main",
          lastRoutePolicy: "session",
          matchedBy: "default",
        });
        vi.mocked(core.channel.inbound.run).mockImplementation(async (input) => {
          expect(input).toMatchObject({ channel: "twitch", accountId: "default" });
          const normalized = await input.adapter.ingest(input.raw);
          if (!normalized) {
            throw new Error("Expected a normalized message");
          }
          const turn = await input.adapter.resolveTurn(
            normalized,
            { kind: "message", canStartAgentTurn: true },
            {},
          );
          if (!("delivery" in turn)) {
            throw new Error("Expected a reply delivery turn");
          }
          expect(turn.cfg).toBe(config);
          const result = await turn.delivery.deliver(payload, { kind: "final" });
          expect(result).toEqual({ visibleReplySent: visible });
          expect(turn.delivery.onDelivered).toBeTypeOf("function");
          await turn.delivery.onDelivered?.(payload, { kind: "final" }, result);
          // This fixture invokes adapter delivery only, not an agent dispatch.
          return { admission: { kind: "handled", reason: "delivery fixture" }, dispatched: false };
        });
        await dispatch({
          id: "message-1",
          username: "viewer",
          userId: "viewer-1",
          message: "@testbot hello bot",
          channel: "testchannel",
        });
        if (expectedText) {
          expect(send).toHaveBeenCalledWith(
            account,
            "testchannel",
            expectedText,
            config,
            "default",
          );
        } else {
          expect(send).not.toHaveBeenCalled();
        }
        expect(error.mock.calls).toEqual(expectedError ? [[expectedError]] : []);
        expect(statusSink.mock.calls.filter(([patch]) => "lastOutboundAt" in patch)).toEqual(
          visible ? [[{ lastOutboundAt: expect.any(Number) }]] : [],
        );
        return fixture;
      },
    );
    expect(completed.unregister).toHaveBeenCalledOnce();
    expect(completed.ingressStop).toHaveBeenCalledOnce();
  });
});
