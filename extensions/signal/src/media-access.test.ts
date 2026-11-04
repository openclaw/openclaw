import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";
import { registerSignalReplyContext } from "./reply-authors.js";
import { sendMessageSignal } from "./send.js";
import {
  signalJsonServer,
  listenSignalServer,
  type SignalRpcEnvelope,
} from "./signal-rpc.test-support.js";

const reactionStores = await vi.hoisted(() => import("./approval-reactions.test-support.js"));
const SIGNAL_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

type SignalMediaContext = Omit<
  Parameters<NonNullable<NonNullable<typeof signalPlugin.outbound>["sendFormattedMedia"]>>[0],
  "onDeliveryResult"
> & { deps?: { signal: typeof sendMessageSignal } };

function requireAdapter<T>(send: T | undefined): T {
  if (!send) {
    throw new Error("Signal adapter is unavailable");
  }
  return send;
}

const SIGNAL_MEDIA_ADAPTERS = [
  {
    name: "message adapter",
    deliver: requireAdapter(signalPlugin.message?.send?.media),
    text: requireAdapter(signalPlugin.message?.send?.text),
  },
  {
    name: "formatted outbound adapter",
    deliver: requireAdapter(signalPlugin.outbound?.sendFormattedMedia),
    text: requireAdapter(signalPlugin.outbound?.sendFormattedText),
  },
] as const;
const SENT_MESSAGE = { messageId: "1700000000999" };

describe("Signal host-owned outbound media access", () => {
  let state: OpenClawTestState;
  let server: http.Server;
  let cfg: OpenClawConfig;
  let requests: Array<{ envelope: SignalRpcEnvelope; attachment: Buffer | undefined }>;
  let onRequest: (() => void) | undefined;
  let rejectQuotes: boolean;
  let caller: AbortController;
  const close = () => caller.abort(new Error("Signal caller closed"));

  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-signal-media-access-",
    });
    await fs.writeFile(path.join(state.workspaceDir, "chart.png"), SIGNAL_IMAGE);
    requests = [];
    onRequest = undefined;
    rejectQuotes = false;
    caller = new AbortController();
    server = signalJsonServer(async (envelope, _request, response) => {
      const attachmentPath = envelope.params?.attachments?.[0];
      requests.push({
        envelope,
        attachment: attachmentPath ? await fs.readFile(attachmentPath) : undefined,
      });
      onRequest?.();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: envelope.id,
          ...(rejectQuotes && envelope.params?.quoteTimestamp !== undefined
            ? { error: { code: -32602, message: "quote metadata invalid" } }
            : { result: { timestamp: 1700000000999, results: [{ type: "SUCCESS" }] } }),
        }),
      );
    });
    cfg = await listenSignalServer(server);
    cfg = { channels: { signal: { ...cfg.channels?.signal, reactionLevel: "minimal" } } };
  });

  afterEach(async () => {
    try {
      if (server?.listening) {
        await server[Symbol.asyncDispose]();
      }
    } finally {
      reactionStores.clearSignalApprovalReactionStoresForTest();
      vi.restoreAllMocks();
      await state?.cleanup();
    }
  });

  function createContext(overrides: Partial<SignalMediaContext> = {}): SignalMediaContext {
    return { ...textContext(), text: "attachment", mediaUrl: "chart.png", ...overrides };
  }

  function workspaceAccess(readFile?: OutboundMediaAccess["readFile"]): OutboundMediaAccess {
    return { localRoots: [state.workspaceDir], workspaceDir: state.workspaceDir, readFile };
  }
  function registerQuote() {
    return registerSignalReplyContext({
      accountId: "default",
      to: "+15551234567",
      replyToId: "1700000000001",
      author: "+15550002222",
      body: "original message",
    });
  }
  function textContext() {
    return {
      cfg,
      to: "+15551234567",
      text: "A pending reply",
      assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
    };
  }
  async function rejectedBeforeSend(delivery: Promise<unknown>, error = "Signal caller closed") {
    await expect(delivery).rejects.toThrow(error);
    expect(requests).toHaveLength(0);
  }

  it.each(SIGNAL_MEDIA_ADAPTERS)(
    "sends approved media with quotes via $name",
    async ({ deliver }) => {
      const sourcePath = path.join(state.workspaceDir, "chart.png");
      const conflictingRoot = state.path("conflicting-root");
      await fs.mkdir(conflictingRoot);
      const approvedReader = vi.fn(async (filePath: string) => await fs.readFile(filePath));
      const conflictingReader = vi.fn(async () => Buffer.from("untrusted bytes"));
      const mediaAccess = workspaceAccess(approvedReader);
      await registerQuote();

      const result = await deliver(
        createContext({
          mediaAccess,
          mediaLocalRoots: [conflictingRoot],
          mediaReadFile: conflictingReader,
          replyToId: "1700000000001",
          deps: { signal: sendMessageSignal },
        }),
      );

      expect(result).toMatchObject(SENT_MESSAGE);
      expect(approvedReader).toHaveBeenCalledExactlyOnceWith(sourcePath);
      expect(conflictingReader).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.attachment).toEqual(SIGNAL_IMAGE);
      expect(requests[0]?.envelope).toMatchObject({
        method: "send",
        params: {
          account: "+15550001111",
          recipient: ["+15551234567"],
          quoteTimestamp: 1700000000001,
          quoteAuthor: "+15550002222",
          quoteMessage: "original message",
        },
      });
    },
  );

  it.each(
    SIGNAL_MEDIA_ADAPTERS.flatMap(({ name, deliver }) =>
      ["during read", "after transmission"].map((phase) => ({ name, deliver, phase })),
    ),
  )("settles the $name when its caller closes $phase", async ({ deliver, phase }) => {
    const readFile = vi.fn(async (filePath: string) => {
      const bytes = await fs.readFile(filePath);
      close();
      return bytes;
    });
    if (phase === "after transmission") {
      onRequest = close;
    }
    const delivery = deliver(
      createContext({
        mediaAccess: workspaceAccess(phase === "during read" ? readFile : undefined),
      }),
    );
    if (phase === "during read") {
      await rejectedBeforeSend(delivery);
      expect(readFile).toHaveBeenCalledOnce();
    } else {
      await expect(delivery).resolves.toMatchObject(SENT_MESSAGE);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.attachment).toEqual(SIGNAL_IMAGE);
    }
  });

  it.each(SIGNAL_MEDIA_ADAPTERS)("gates prepared $name text", async ({ text: send }) => {
    const delivery = send(textContext());
    close();
    await rejectedBeforeSend(delivery);
  });

  it.each([false, true])("keeps quote fallback on the same caller (closed=%s)", async (closed) => {
    const send = requireAdapter(signalPlugin.message?.send?.text);
    await registerQuote();
    rejectQuotes = true;
    if (closed) {
      onRequest = close;
    }
    const delivery = send({
      ...textContext(),
      text: "A quoted reply",
      replyToId: "1700000000001",
    });

    if (closed) {
      await expect(delivery).rejects.toThrow("Signal caller closed");
      expect(requests).toHaveLength(1);
    } else {
      await expect(delivery).resolves.toMatchObject(SENT_MESSAGE);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.envelope.params).not.toHaveProperty("quoteTimestamp");
    }
    expect(requests[0]?.envelope.params?.quoteTimestamp).toBe(1700000000001);
  });

  it("preserves a reported text chunk and stops later chunks when its caller closes", async () => {
    const send = requireAdapter(signalPlugin.outbound?.sendFormattedText);
    const delivered: unknown[] = [];
    await expect(
      send({
        ...textContext(),
        cfg: {
          ...cfg,
          channels: { signal: { ...cfg.channels?.signal, textChunkLimit: 4 } },
        },
        text: "one\n\ntwo\n\nthree",
        onDeliveryResult: (result) => {
          delivered.push(result);
          caller.abort(new Error("Signal caller closed between chunks"));
        },
      }),
    ).rejects.toThrow("Signal caller closed between chunks");
    expect(requests).toHaveLength(1);
    expect(delivered).toEqual([expect.objectContaining(SENT_MESSAGE)]);
  });

  it.each([false, true])("stops a closed caller's reaction (remove=%s)", async (remove) => {
    const react = requireAdapter(signalPlugin.actions?.handleAction);
    close();
    await rejectedBeforeSend(
      react({
        channel: "signal",
        action: "react",
        cfg,
        params: { to: "+15551234567", messageId: "1700000000001", emoji: "👍", remove },
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      }),
    );
  });

  it.each(SIGNAL_MEDIA_ADAPTERS)("rejects traversal before I/O via $name", async ({ deliver }) => {
    await fs.writeFile(state.path("outside.png"), SIGNAL_IMAGE);
    const approvedReader = vi.fn(async (filePath: string) => await fs.readFile(filePath));
    const conflictingReader = vi.fn(async (filePath: string) => await fs.readFile(filePath));

    const delivery = deliver(
      createContext({
        mediaUrl: "../outside.png",
        mediaLocalRoots: [state.root],
        mediaReadFile: conflictingReader,
        mediaAccess: workspaceAccess(approvedReader),
      }),
    );
    await expect(delivery).rejects.toMatchObject({ code: "path-not-allowed" });

    expect(approvedReader).not.toHaveBeenCalled();
    expect(conflictingReader).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("propagates host-reader failures without contacting Signal", async () => {
    const deniedReader = vi.fn(async (): Promise<Buffer> => {
      throw new Error("host denied this attachment");
    });
    await rejectedBeforeSend(
      SIGNAL_MEDIA_ADAPTERS[0].deliver(
        createContext({ mediaAccess: workspaceAccess(deniedReader) }),
      ),
      "host denied this attachment",
    );
    expect(deniedReader).toHaveBeenCalledOnce();
  });
});
