import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSignalApprovalReactionTargetsForTest } from "./approval-reactions.js";
import { signalPlugin } from "./channel.js";
import { registerSignalReplyContext } from "./reply-authors.js";
import { sendMessageSignal } from "./send.js";

const SIGNAL_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

function decodeInlineAttachment(attachment: string | undefined): Buffer | undefined {
  if (!attachment?.startsWith("data:")) {
    return undefined;
  }
  const marker = ";base64,";
  const markerAt = attachment.indexOf(marker);
  if (markerAt === -1) {
    return undefined;
  }
  return Buffer.from(attachment.slice(markerAt + marker.length), "base64");
}

type SignalMediaContext = {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  mediaUrl: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  replyToId?: string;
  assertDirectAdapterHandoff?: () => void;
  deps?: { signal: typeof sendMessageSignal };
};

type SignalRpcEnvelope = {
  id?: string | number;
  method?: string;
  params?: {
    account?: string;
    recipient?: string[];
    message?: string;
    attachments?: string[];
    quoteTimestamp?: number;
    quoteAuthor?: string;
    quoteMessage?: string;
  };
};

const SIGNAL_MEDIA_ADAPTERS = [
  {
    name: "message adapter",
    deliver: async (context: SignalMediaContext) => {
      const send = signalPlugin.message?.send?.media;
      if (!send) {
        throw new Error("Signal message media adapter is unavailable");
      }
      return await send(context);
    },
  },
  {
    name: "formatted outbound adapter",
    deliver: async (context: SignalMediaContext) => {
      const send = signalPlugin.outbound?.sendFormattedMedia;
      if (!send) {
        throw new Error("Signal formatted media adapter is unavailable");
      }
      return await send(context);
    },
  },
] as const;

describe("Signal host-owned outbound media access", () => {
  let state: OpenClawTestState;
  let server: http.Server;
  let cfg: OpenClawConfig;
  let requests: Array<{ envelope: SignalRpcEnvelope; attachment: Buffer | undefined }>;
  let onRequest: (() => void) | undefined;
  let rejectQuotes: boolean;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-signal-media-access-",
    });
    requests = [];
    onRequest = undefined;
    rejectQuotes = false;
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      request.on("end", () => {
        void (async () => {
          const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SignalRpcEnvelope;
          const attachment = envelope.params?.attachments?.[0];
          requests.push({
            envelope,
            attachment: decodeInlineAttachment(attachment),
          });
          onRequest?.();
          response.writeHead(200, { "content-type": "application/json" });
          if (rejectQuotes && envelope.params?.quoteTimestamp !== undefined) {
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: envelope.id,
                error: { code: -32602, message: "quote metadata invalid" },
              }),
            );
            return;
          }
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: envelope.id,
              result: { timestamp: 1700000000999, results: [{ type: "SUCCESS" }] },
            }),
          );
        })().catch((error: unknown) => {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end(String(error));
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Signal test server did not expose a TCP port");
    }
    cfg = {
      channels: {
        signal: {
          reactionLevel: "minimal",
          accounts: {
            default: {
              account: "+15550001111",
              transport: { kind: "external-native", url: `http://127.0.0.1:${address.port}` },
            },
          },
        },
      },
    };
  });

  afterEach(async () => {
    try {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      clearSignalApprovalReactionTargetsForTest();
      vi.restoreAllMocks();
      await state?.cleanup();
    }
  });

  function createContext(overrides: Partial<SignalMediaContext> = {}): SignalMediaContext {
    return {
      cfg,
      to: "+15551234567",
      text: "Workspace attachment",
      mediaUrl: "chart.png",
      ...overrides,
    };
  }

  it.each(SIGNAL_MEDIA_ADAPTERS)(
    "delivers approved workspace bytes through the real $name and preserves native quotes",
    async ({ deliver }) => {
      const sourcePath = path.join(state.workspaceDir, "chart.png");
      const conflictingRoot = state.path("conflicting-root");
      await fs.mkdir(conflictingRoot);
      await fs.writeFile(sourcePath, SIGNAL_IMAGE);
      const approvedReader = vi.fn(async (filePath: string) => await fs.readFile(filePath));
      const conflictingReader = vi.fn(async () => Buffer.from("untrusted bytes"));
      const mediaAccess = {
        localRoots: [state.workspaceDir],
        workspaceDir: state.workspaceDir,
        readFile: approvedReader,
      } satisfies OutboundMediaAccess;
      const send = vi.fn(sendMessageSignal);
      await registerSignalReplyContext({
        accountId: "default",
        to: "+15551234567",
        replyToId: "1700000000001",
        author: "+15550002222",
        body: "original message",
      });

      const result = await deliver(
        createContext({
          mediaAccess,
          mediaLocalRoots: [conflictingRoot],
          mediaReadFile: conflictingReader,
          replyToId: "1700000000001",
          deps: { signal: send },
        }),
      );

      expect(result).toMatchObject({ messageId: "1700000000999" });
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[2].mediaAccess).toBe(mediaAccess);
      expect(send.mock.calls[0]?.[2].mediaLocalRoots).toEqual([conflictingRoot]);
      expect(send.mock.calls[0]?.[2].mediaReadFile).toBe(conflictingReader);
      expect(approvedReader).toHaveBeenCalledExactlyOnceWith(sourcePath);
      expect(conflictingReader).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.envelope.params?.attachments).toEqual([
        expect.stringMatching(/^data:image\/png;filename=chart\.png;base64,/),
      ]);
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
    SIGNAL_MEDIA_ADAPTERS.flatMap((adapter) =>
      ["during read", "after transmission"].map((phase) => ({
        name: adapter.name,
        deliver: adapter.deliver,
        phase,
      })),
    ),
  )("settles the $name when its caller closes $phase", async ({ deliver, phase }) => {
    await fs.writeFile(path.join(state.workspaceDir, "chart.png"), SIGNAL_IMAGE);
    const caller = new AbortController();
    const close = () => caller.abort(new Error("Signal caller closed"));
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
        mediaAccess: {
          localRoots: [state.workspaceDir],
          workspaceDir: state.workspaceDir,
          ...(phase === "during read" ? { readFile } : {}),
        },
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      }),
    );
    if (phase === "during read") {
      await expect(delivery).rejects.toThrow("Signal caller closed");
      expect(readFile).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(0);
    } else {
      await expect(delivery).resolves.toMatchObject({ messageId: "1700000000999" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.envelope.params?.attachments?.[0]).toMatch(
        /^data:image\/png;filename=chart\.png;base64,/,
      );
      expect(requests[0]?.attachment).toEqual(SIGNAL_IMAGE);
    }
  });

  it.each(["message", "formatted"] as const)(
    "checks the current caller after preparation for %s text delivery",
    async (adapter) => {
      const caller = new AbortController();
      const send =
        adapter === "message"
          ? signalPlugin.message?.send?.text
          : signalPlugin.outbound?.sendFormattedText;
      if (!send) {
        throw new Error("Signal text sender is unavailable");
      }
      const delivery = send({
        cfg,
        to: "+15551234567",
        text: "A pending reply",
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      });
      caller.abort(new Error("Signal caller closed"));

      await expect(delivery).rejects.toThrow("Signal caller closed");
      expect(requests).toHaveLength(0);
    },
  );

  it.each([false, true])("keeps quote fallback on the same caller (closed=%s)", async (closed) => {
    const send = signalPlugin.message?.send?.text;
    if (!send) {
      throw new Error("Signal message text adapter is unavailable");
    }
    await registerSignalReplyContext({
      accountId: "default",
      to: "+15551234567",
      replyToId: "1700000000001",
      author: "+15550002222",
      body: "original message",
    });
    const caller = new AbortController();
    rejectQuotes = true;
    if (closed) {
      onRequest = () => caller.abort(new Error("Signal caller closed"));
    }
    const delivery = send({
      cfg,
      to: "+15551234567",
      text: "A quoted reply",
      replyToId: "1700000000001",
      assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
    });

    if (closed) {
      await expect(delivery).rejects.toThrow("Signal caller closed");
      expect(requests).toHaveLength(1);
    } else {
      await expect(delivery).resolves.toMatchObject({ messageId: "1700000000999" });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.envelope.params).not.toHaveProperty("quoteTimestamp");
    }
    expect(requests[0]?.envelope.params?.quoteTimestamp).toBe(1700000000001);
  });

  it("preserves a reported text chunk and stops later chunks when its caller closes", async () => {
    const send = signalPlugin.outbound?.sendFormattedText;
    if (!send) {
      throw new Error("Signal formatted text adapter is unavailable");
    }
    const caller = new AbortController();
    const delivered: unknown[] = [];

    await expect(
      send({
        cfg: {
          ...cfg,
          channels: { signal: { ...cfg.channels?.signal, textChunkLimit: 4 } },
        },
        to: "+15551234567",
        text: "one\n\ntwo\n\nthree",
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
        onDeliveryResult: (result) => {
          delivered.push(result);
          caller.abort(new Error("Signal caller closed between chunks"));
        },
      }),
    ).rejects.toThrow("Signal caller closed between chunks");
    expect(requests).toHaveLength(1);
    expect(delivered).toEqual([expect.objectContaining({ messageId: "1700000000999" })]);
  });

  it.each([false, true])("stops a closed caller's reaction (remove=%s)", async (remove) => {
    const react = signalPlugin.actions?.handleAction;
    if (!react) {
      throw new Error("Signal reaction adapter is unavailable");
    }
    const caller = new AbortController();
    caller.abort(new Error("Signal caller closed"));

    await expect(
      react({
        channel: "signal",
        action: "react",
        cfg,
        params: { to: "+15551234567", messageId: "1700000000001", emoji: "👍", remove },
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      }),
    ).rejects.toThrow("Signal caller closed");
    expect(requests).toHaveLength(0);
  });

  it.each(SIGNAL_MEDIA_ADAPTERS)(
    "rejects traversal before reading or contacting Signal through the $name",
    async ({ deliver }) => {
      await fs.writeFile(state.path("outside.png"), SIGNAL_IMAGE);
      const approvedReader = vi.fn(async (filePath: string) => await fs.readFile(filePath));
      const conflictingReader = vi.fn(async (filePath: string) => await fs.readFile(filePath));

      await expect(
        deliver(
          createContext({
            mediaUrl: "../outside.png",
            mediaLocalRoots: [state.root],
            mediaReadFile: conflictingReader,
            mediaAccess: {
              localRoots: [state.workspaceDir],
              workspaceDir: state.workspaceDir,
              readFile: approvedReader,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "path-not-allowed" });

      expect(approvedReader).not.toHaveBeenCalled();
      expect(conflictingReader).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
    },
  );

  it("propagates host-reader failures without contacting Signal", async () => {
    await fs.writeFile(path.join(state.workspaceDir, "chart.png"), SIGNAL_IMAGE);
    const deniedReader = vi.fn(async (): Promise<Buffer> => {
      throw new Error("host denied this attachment");
    });

    await expect(
      SIGNAL_MEDIA_ADAPTERS[0].deliver(
        createContext({
          mediaAccess: {
            localRoots: [state.workspaceDir],
            workspaceDir: state.workspaceDir,
            readFile: deniedReader,
          },
        }),
      ),
    ).rejects.toThrow("host denied this attachment");

    expect(deniedReader).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });
});
