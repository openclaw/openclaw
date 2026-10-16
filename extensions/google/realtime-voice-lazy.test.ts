import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import { beforeEach, describe, expect, it, vi } from "vitest";
import googlePlugin from "./index.js";
import { createMockRealtimeBridge } from "./realtime-voice-lazy.test-helpers.js";

const { createRealtimeBridgeMock } = vi.hoisted(() => ({
  createRealtimeBridgeMock: vi.fn<(req: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge>(),
}));

vi.mock("./realtime-voice-provider.js", () => ({
  buildGoogleRealtimeVoiceProvider: () => ({
    id: "google",
    label: "Google Live Voice",
    createBridge: createRealtimeBridgeMock,
  }),
}));

function createLazyRealtimeBridge(
  onError = vi.fn(),
  onReady?: () => void,
  onClose?: (reason: "completed" | "error") => void,
  callbacks: Partial<RealtimeVoiceBridgeCreateRequest> = {},
) {
  const captured = createCapturedPluginRegistration({ id: "google" });
  googlePlugin.register(captured.api);
  const realtimeProvider = captured.realtimeVoiceProviders.find(
    (provider) => provider.id === "google",
  );
  const bridge = realtimeProvider?.createBridge({
    providerConfig: { apiKey: "gemini-key" },
    onAudio() {},
    onClearAudio() {},
    onError,
    onReady,
    onClose,
    ...callbacks,
  });
  if (!bridge) {
    throw new Error("expected Google realtime bridge");
  }
  return { bridge, onError };
}

function signalRealtimeBridgeReady() {
  const request = createRealtimeBridgeMock.mock.calls.at(-1)?.[0];
  if (!request) {
    throw new Error("expected Google realtime bridge request");
  }
  request.onReady?.();
}

function signalRealtimeBridgeClose(reason: "completed" | "error") {
  const request = createRealtimeBridgeMock.mock.calls.at(-1)?.[0];
  if (!request) {
    throw new Error("expected Google realtime bridge request");
  }
  request.onClose?.(reason);
}

beforeEach(() => createRealtimeBridgeMock.mockReset());

it("fences response completion from a closed Google provider generation", async () => {
  createRealtimeBridgeMock.mockImplementation(() => createMockRealtimeBridge().bridge);
  const onResponseDone = vi.fn();
  const { bridge } = createLazyRealtimeBridge(vi.fn(), undefined, undefined, { onResponseDone });
  const result = { status: "completed" } as const;
  await bridge.connect();
  const firstRequest = createRealtimeBridgeMock.mock.calls[0]?.[0];
  void bridge.close();
  firstRequest?.onResponseDone?.(result);
  expect(onResponseDone).not.toHaveBeenCalled();

  await bridge.connect();
  firstRequest?.onResponseDone?.(result);
  expect(onResponseDone).not.toHaveBeenCalled();
  createRealtimeBridgeMock.mock.calls[1]?.[0]?.onResponseDone?.(result);
  expect(onResponseDone).toHaveBeenCalledExactlyOnceWith(result);
  await bridge.close();
});

describe("Google lazy realtime voice", () => {
  it("evicts the oldest lazy audio when the startup chunk limit is reached", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge } = createLazyRealtimeBridge();

    for (let index = 0; index < 322; index += 1) {
      bridge.sendAudio(Buffer.from([index & 0xff]));
    }
    await bridge.connect();
    signalRealtimeBridgeReady();

    expect(loaded.sendAudio).toHaveBeenCalledTimes(320);
    expect(loaded.sendAudio.mock.calls[0]?.[0]).toEqual(Buffer.from([2]));
    expect(loaded.sendAudio.mock.calls.at(-1)?.[0]).toEqual(Buffer.from([65]));
  });

  it("preserves lazy audio order across bridge loading and provider readiness", async () => {
    const connected = createDeferred<void>();
    const loaded = createMockRealtimeBridge(() => connected.promise);
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge } = createLazyRealtimeBridge();

    bridge.sendAudio(Buffer.from([0x01]));
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(loaded.connect).toHaveBeenCalledOnce());
    bridge.sendAudio(Buffer.from([0x02]));

    expect(loaded.sendAudio).not.toHaveBeenCalled();
    connected.resolve();
    await connectPromise;
    expect(loaded.sendAudio).not.toHaveBeenCalled();

    signalRealtimeBridgeReady();
    expect(loaded.sendAudio.mock.calls.map(([audio]) => audio)).toEqual([
      Buffer.from([0x01]),
      Buffer.from([0x02]),
    ]);
  });

  it("copies lazy audio and evicts oldest chunks to enforce the byte limit", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge } = createLazyRealtimeBridge();
    const backing = Buffer.alloc(2 * 1024 * 1024, 0x02);
    const retainedView = backing.subarray(0, 512 * 1024);

    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x01));
    bridge.sendAudio(retainedView);
    retainedView.fill(0);
    bridge.sendAudio(Buffer.from([0x03]));
    bridge.sendAudio(Buffer.alloc(1024 * 1024 + 1, 0x04));
    await bridge.connect();
    signalRealtimeBridgeReady();

    expect(loaded.sendAudio).toHaveBeenCalledTimes(2);
    const retainedAudio = loaded.sendAudio.mock.calls[0]?.[0];
    expect(
      Buffer.isBuffer(retainedAudio) && retainedAudio.equals(Buffer.alloc(512 * 1024, 0x02)),
    ).toBe(true);
    expect(loaded.sendAudio.mock.calls[1]?.[0]).toEqual(Buffer.from([0x03]));
  });

  it("clears lazy audio on terminal close and reopens only for an explicit connect", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const onClose = vi.fn();
    const { bridge } = createLazyRealtimeBridge(vi.fn(), undefined, onClose);

    bridge.sendAudio(Buffer.from([0x01]));
    await bridge.connect();
    signalRealtimeBridgeClose("error");
    bridge.sendAudio(Buffer.from([0x02]));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
    expect(loaded.sendAudio).not.toHaveBeenCalled();

    await bridge.connect();
    signalRealtimeBridgeReady();
    expect(loaded.sendAudio).not.toHaveBeenCalled();

    bridge.sendAudio(Buffer.from([0x03]));
    expect(loaded.sendAudio).toHaveBeenCalledOnce();
    expect(loaded.sendAudio).toHaveBeenCalledWith(Buffer.from([0x03]));
    await bridge.close();
  });

  it("fences a provider generation closed during lazy load before reconnecting", async () => {
    const first = createMockRealtimeBridge();
    const replacement = createMockRealtimeBridge();
    replacement.bridge.isConnected = vi.fn(() => replacement.connect.mock.calls.length > 0);
    createRealtimeBridgeMock
      .mockReturnValueOnce(first.bridge)
      .mockReturnValueOnce(replacement.bridge);
    const { bridge } = createLazyRealtimeBridge();

    const staleConnect = bridge.connect();
    void bridge.close();
    const replacementConnect = bridge.connect();
    bridge.sendAudio(Buffer.from([0x02]));
    await Promise.all([staleConnect, replacementConnect]);
    signalRealtimeBridgeReady();

    expect(first.connect).not.toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledOnce();
    expect(replacement.connect).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(replacement.sendAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([0x02]));
    expect(bridge.isConnected()).toBe(true);
  });

  it("discards failed-startup input and accepts fresh input only after reconnecting", async () => {
    const failure = new Error("provider connect rejected");
    const failed = createMockRealtimeBridge(async () => {
      throw failure;
    });
    const reconnected = createMockRealtimeBridge();
    createRealtimeBridgeMock
      .mockReturnValueOnce(failed.bridge)
      .mockReturnValueOnce(reconnected.bridge);
    const { bridge, onError } = createLazyRealtimeBridge();

    bridge.sendAudio(Buffer.from([0x01]));
    bridge.sendUserMessage?.("discarded");
    await expect(bridge.connect()).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(failed.close).toHaveBeenCalledOnce();
    expect(failed.sendAudio).not.toHaveBeenCalled();
    expect(failed.sendUserMessage).not.toHaveBeenCalled();
    bridge.sendAudio(Buffer.from([0x02]));
    bridge.sendUserMessage?.("also discarded");

    const reconnecting = bridge.connect();
    bridge.sendAudio(Buffer.from([0x03]));
    bridge.sendUserMessage?.("accepted");
    await reconnecting;
    expect(reconnected.sendAudio).not.toHaveBeenCalled();
    expect(reconnected.sendUserMessage).not.toHaveBeenCalled();
    signalRealtimeBridgeReady();
    expect(reconnected.sendAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([0x03]));
    expect(reconnected.sendUserMessage).toHaveBeenCalledExactlyOnceWith("accepted");
  });

  it("reports one terminal error when concurrent lazy connects reject together", async () => {
    const failure = new Error("shared Google realtime connect rejected");
    const connecting = createDeferred<void>();
    const loaded = createMockRealtimeBridge(() => connecting.promise);
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const onError = vi.fn();
    const onClose = vi.fn();
    const { bridge } = createLazyRealtimeBridge(onError, undefined, onClose);

    const firstConnect = bridge.connect();
    const secondConnect = bridge.connect();
    const connectResults = Promise.allSettled([firstConnect, secondConnect]);
    await vi.waitFor(() => expect(loaded.connect).toHaveBeenCalledOnce());
    connecting.reject(failure);

    expect(await connectResults).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
    expect(loaded.close).toHaveBeenCalledOnce();
  });

  it("preserves queued user messages until the loaded bridge reports ready", async () => {
    const connected = createDeferred<void>();
    const loaded = createMockRealtimeBridge(() => connected.promise);
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge } = createLazyRealtimeBridge();

    bridge.sendUserMessage?.("before connect");
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(loaded.connect).toHaveBeenCalledOnce());
    bridge.sendUserMessage?.("during connect");

    expect(loaded.sendUserMessage).not.toHaveBeenCalled();
    connected.resolve();
    await connectPromise;

    expect(loaded.sendUserMessage).not.toHaveBeenCalled();
    signalRealtimeBridgeReady();

    expect(loaded.sendUserMessage.mock.calls.map(([text]) => text)).toEqual([
      "before connect",
      "during connect",
    ]);
  });

  it("rejects each user message beyond the lazy startup queue count", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge, onError } = createLazyRealtimeBridge();

    for (let index = 0; index < 130; index += 1) {
      bridge.sendUserMessage?.(`message-${index}`);
    }
    await bridge.connect();
    signalRealtimeBridgeReady();

    expect(loaded.sendUserMessage).toHaveBeenCalledTimes(128);
    expect(loaded.sendUserMessage.mock.calls.map(([text]) => text)).toEqual(
      Array.from({ length: 128 }, (_, index) => `message-${index}`),
    );
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: expect.stringContaining("queue overflow") }),
    );
    expect(onError).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: expect.stringContaining("queue overflow") }),
    );
  });

  it("bounds the lazy startup queue by aggregate UTF-8 bytes", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge, onError } = createLazyRealtimeBridge();
    const exactLimit = "🙂".repeat((256 * 1024) / 4);

    expect(Buffer.byteLength(exactLimit, "utf8")).toBe(256 * 1024);
    bridge.sendUserMessage?.(exactLimit);
    bridge.sendUserMessage?.("overflow");
    await bridge.connect();
    signalRealtimeBridgeReady();

    expect(loaded.sendUserMessage).toHaveBeenCalledOnce();
    expect(loaded.sendUserMessage).toHaveBeenCalledWith(exactLimit);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("clears queued messages and ignores a late connect completion after close", async () => {
    const connected = createDeferred<void>();
    const loaded = createMockRealtimeBridge(() => connected.promise);
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const { bridge } = createLazyRealtimeBridge();

    bridge.sendUserMessage?.("before connect");
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(loaded.connect).toHaveBeenCalledOnce());
    bridge.sendUserMessage?.("during connect");
    void bridge.close();
    void bridge.close();
    bridge.sendUserMessage?.("after close");
    connected.resolve();
    await connectPromise;
    signalRealtimeBridgeReady();

    expect(loaded.close).toHaveBeenCalledOnce();
    expect(loaded.sendUserMessage).not.toHaveBeenCalled();
  });

  it("keeps close precedence when the readiness callback closes the lazy bridge", async () => {
    const loaded = createMockRealtimeBridge();
    createRealtimeBridgeMock.mockReturnValue(loaded.bridge);
    const bridgeRef: { current?: RealtimeVoiceBridge } = {};
    const onReady = vi.fn(() => void bridgeRef.current?.close());
    const { bridge } = createLazyRealtimeBridge(vi.fn(), onReady);
    bridgeRef.current = bridge;

    bridge.sendUserMessage?.("queued prompt");
    bridge.triggerGreeting?.("queued greeting");
    await bridge.connect();
    signalRealtimeBridgeReady();

    expect(onReady).toHaveBeenCalledOnce();
    expect(loaded.close).toHaveBeenCalledOnce();
    expect(loaded.sendUserMessage).not.toHaveBeenCalled();
    expect(loaded.triggerGreeting).not.toHaveBeenCalled();
  });
});
