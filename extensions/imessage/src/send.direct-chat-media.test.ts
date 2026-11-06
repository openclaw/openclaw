import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClient,
  createRejectingClient,
  createSendConfig,
  getClientMocks,
} from "./send.test-support.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

type ClientModule = typeof import("./client.js");
type ErrorRuntimeModule = typeof import("openclaw/plugin-sdk/error-runtime");
type SendModule = typeof import("./send.js");
let IMessageRpcRequestError: ClientModule["IMessageRpcRequestError"];
let PlatformMessageNotDispatchedError: ErrorRuntimeModule["PlatformMessageNotDispatchedError"];
let sendMessageIMessage: SendModule["sendMessageIMessage"];
let cliOutput: typeof import("./cli-output.js");
let mediaRuntime: typeof import("openclaw/plugin-sdk/media-runtime");

// Ordinary media addressed to an explicit direct chat must reach imsg's canonical send RPC, which
// recovers a chat Messages.app no longer lists (-1728) and reports typed not-dispatched custody.
// Group media, an explicit bridge and remote hosts keep the native attachment route.
describe("iMessage direct-chat media routing", () => {
  let openClawState: OpenClawTestState;
  const IMESSAGE_TEST_CFG = createSendConfig({ accounts: { default: {} } });

  beforeEach(async () => {
    openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-imessage-direct-media-",
    });
    await loadFreshIMessageReplyCacheForTest();
    ({ IMessageRpcRequestError } = await import("./client.js"));
    ({ PlatformMessageNotDispatchedError } = await import("openclaw/plugin-sdk/error-runtime"));
    ({ sendMessageIMessage } = await import("./send.js"));
    cliOutput = await import("./cli-output.js");
    mediaRuntime = await import("openclaw/plugin-sdk/media-runtime");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await openClawState.cleanup();
  });

  function mockAttachment(value: { path: string; contentType?: string }) {
    return vi.spyOn(mediaRuntime, "resolveOutboundAttachmentFromUrl").mockResolvedValue(value);
  }

  function mockCliSend() {
    const run = vi.fn<(args: readonly string[]) => Promise<Record<string, unknown>>>();
    vi.spyOn(cliOutput, "runIMessageCliJsonCommand").mockImplementation(({ args }) => run(args));
    return run;
  }

  it("routes explicit direct-chat media through the canonical send RPC", async () => {
    const client = createClient({ guid: "p:0/direct-chat-media" });
    const runCliJson = mockCliSend().mockResolvedValueOnce({
      guid: "any;-;user@example.com",
      is_group: false,
    });
    mockAttachment({ path: "/tmp/image.png", contentType: "image/png" });

    const result = await sendMessageIMessage("chat_id:42", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
    });

    expect(result.messageId).toBe("p:0/direct-chat-media");
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["media"]);
    // Only the read-only chat lookup stays native; the send itself uses imsg's RPC,
    // which recovers a direct chat that Messages.app no longer lists (-1728).
    expect(runCliJson.mock.calls).toEqual([[["group", "--chat-id", "42"]]]);
    expect(getClientMocks(client).request).toHaveBeenCalledExactlyOnceWith(
      "send",
      expect.objectContaining({ chat_id: 42, file: "/tmp/image.png" }),
      expect.any(Object),
    );
  });

  it("routes an explicit direct chat_guid through the canonical send RPC", async () => {
    const client = createClient({ guid: "p:0/direct-guid-media" });
    const runCliJson = mockCliSend();
    mockAttachment({ path: "/tmp/image.png", contentType: "image/png" });

    await sendMessageIMessage("chat_guid:iMessage;-;+15550004567", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
    });

    expect(runCliJson).not.toHaveBeenCalled();
    expect(getClientMocks(client).request).toHaveBeenCalledExactlyOnceWith(
      "send",
      expect.objectContaining({
        chat_guid: "iMessage;-;+15550004567",
        file: "/tmp/image.png",
      }),
      expect.any(Object),
    );
  });

  it("keeps resolved group media on the native attachment route", async () => {
    const client = createClient({ guid: "should-not-send" });
    const runCliJson = mockCliSend()
      .mockResolvedValueOnce({ guid: "iMessage;+;chat0000", is_group: true })
      .mockResolvedValueOnce({ messageGuid: "p:0/group-media" });
    mockAttachment({ path: "/tmp/image.png", contentType: "image/png" });

    const result = await sendMessageIMessage("chat_id:42", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
    });

    expect(result.messageId).toBe("p:0/group-media");
    expect(runCliJson.mock.calls).toEqual([
      [["group", "--chat-id", "42"]],
      [
        [
          "send-attachment",
          "--chat",
          "iMessage;+;chat0000",
          "--file",
          "/tmp/image.png",
          "--transport",
          "auto",
        ],
      ],
    ]);
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("preserves explicit bridge delivery for direct-chat media", async () => {
    const client = createClient({ guid: "should-not-send" });
    const runCliJson = mockCliSend()
      .mockResolvedValueOnce({ guid: "any;-;user@example.com", is_group: false })
      .mockResolvedValueOnce({ messageGuid: "p:0/bridge-direct-media" });
    mockAttachment({ path: "/tmp/image.png", contentType: "image/png" });

    await sendMessageIMessage("chat_id:42", "", {
      config: createSendConfig({ sendTransport: "bridge" }),
      client,
      mediaUrl: "/tmp/image.png",
    });

    expect(runCliJson.mock.calls[1]?.[0]).toEqual([
      "send-attachment",
      "--chat",
      "any;-;user@example.com",
      "--file",
      "/tmp/image.png",
      "--transport",
      "dylib",
    ]);
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("records a stale direct-chat media rejection as not dispatched", async () => {
    const rpcError = new IMessageRpcRequestError(
      "applescript send failed (not_started): Messages automation failed with AppleScript error -1728",
      -32603,
      { retry_safe: true, disposition: "not_started", operation: "send" },
    );
    const client = createRejectingClient(rpcError);
    mockCliSend().mockResolvedValueOnce({ guid: "any;-;user@example.com", is_group: false });
    mockAttachment({ path: "/tmp/image.png", contentType: "image/png" });

    const rejection = await sendMessageIMessage("chat_id:42", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(rejection).toMatchObject({ message: rpcError.message, cause: rpcError });
  });
});
