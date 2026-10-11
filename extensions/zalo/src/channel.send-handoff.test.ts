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
  const lookupStarted = Promise.withResolvers<void>();
  const lookupFinished = Promise.withResolvers<void>();
  resolvePinnedHostnameWithPolicyMock.mockImplementationOnce(async () => {
    lookupStarted.resolve();
    await lookupFinished.promise;
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
  await lookupStarted.promise;
  current = false;
  lookupFinished.resolve();

  await expect(result).rejects.toBe(authorityError);
  expect(assertDirectAdapterHandoff).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
});
