import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { zaloMessageActions } from "./actions.js";
import { zaloPlugin } from "./channel.js";

const { resolvePinnedHostnameWithPolicyMock } = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicyMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

const cfg: OpenClawConfig = {
  channels: { zalo: { enabled: true, botToken: "test-zalo-token" } },
};
const target = "dm-chat-handoff";
const mediaUrl = "https://example.com/photo.jpg";

function requireMessageMediaSend() {
  const send = zaloPlugin.message?.send?.media;
  if (!send) {
    throw new Error("Expected Zalo message adapter media sender");
  }
  return send;
}

function requireLegacyMediaSend() {
  const send = zaloPlugin.outbound?.sendMedia;
  if (!send) {
    throw new Error("Expected Zalo legacy media sender");
  }
  return send;
}

function requirePayloadSend() {
  const send = zaloPlugin.outbound?.sendPayload;
  if (!send) {
    throw new Error("Expected Zalo payload sender");
  }
  return send;
}

function requireMessageActionSend() {
  const send = zaloMessageActions.handleAction;
  if (!send) {
    throw new Error("Expected Zalo message action handler");
  }
  return send;
}

afterEach(() => {
  resolvePinnedHostnameWithPolicyMock.mockReset();
  vi.restoreAllMocks();
});

it.each([
  {
    route: "message adapter",
    send: (assertDirectAdapterHandoff: () => void) =>
      requireMessageMediaSend()({
        cfg,
        to: target,
        text: "caption",
        mediaUrl,
        assertDirectAdapterHandoff,
      }),
  },
  {
    route: "legacy adapter",
    send: (assertDirectAdapterHandoff: () => void) =>
      requireLegacyMediaSend()({
        cfg,
        to: target,
        text: "caption",
        mediaUrl,
        assertDirectAdapterHandoff,
      }),
  },
  {
    route: "payload adapter",
    send: (assertDirectAdapterHandoff: () => void) =>
      requirePayloadSend()({
        cfg,
        to: target,
        text: "",
        payload: { mediaUrl },
        assertDirectAdapterHandoff,
      }),
  },
  {
    route: "message action",
    send: (assertDirectAdapterHandoff: () => void) =>
      requireMessageActionSend()({
        channel: "zalo",
        action: "send",
        params: { to: target, message: "caption", media: mediaUrl },
        cfg,
        accountId: "default",
        assertDirectAdapterHandoff,
      }),
  },
])("rejects revoked $route handoffs after photo preparation", async ({ send }) => {
  let markLookupStarted: (() => void) | undefined;
  let finishLookup: (() => void) | undefined;
  const lookupStarted = new Promise<void>((resolve) => {
    markLookupStarted = resolve;
  });
  const lookupFinished = new Promise<void>((resolve) => {
    finishLookup = resolve;
  });
  resolvePinnedHostnameWithPolicyMock.mockImplementationOnce(async () => {
    markLookupStarted?.();
    await lookupFinished;
    return {
      hostname: "example.com",
      addresses: ["93.184.216.34"],
      lookup: vi.fn(),
    };
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ ok: true, result: { message_id: "unexpected" } }));
  const authorityError = new Error("source authority revoked");
  let current = true;
  const assertDirectAdapterHandoff = vi.fn(() => {
    if (!current) {
      throw authorityError;
    }
  });

  const result = send(assertDirectAdapterHandoff);
  await lookupStarted;
  current = false;
  finishLookup?.();

  await expect(result).rejects.toBe(authorityError);
  expect(assertDirectAdapterHandoff).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
});
