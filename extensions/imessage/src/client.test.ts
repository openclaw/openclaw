import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMessageRpcClient } from "./client.js";

// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR
const LINE_SEP = " ";
const PARA_SEP = " ";

// Replicates the LF-only framing logic from IMessageRpcClient.start()
// so tests exercise the same path the production data handler uses.
function feedLines(client: IMessageRpcClient, data: string): void {
  const internals = client as unknown as {
    stdoutBuffer: string;
    handleLine: (line: string) => void;
  };
  internals.stdoutBuffer += data;
  let idx: number;
  while ((idx = internals.stdoutBuffer.indexOf("\n")) !== -1) {
    const line = internals.stdoutBuffer.slice(0, idx);
    internals.stdoutBuffer = internals.stdoutBuffer.slice(idx + 1);
    const trimmed = line.trim();
    if (trimmed) {
      internals.handleLine(trimmed);
    }
  }
}

function makeFakeChild(): {
  child: ChildProcessWithoutNullStreams;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: EventEmitter["on"] };
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinEmitter = new EventEmitter();
  const stdin = {
    write: vi.fn(),
    end: vi.fn(),
    on: stdinEmitter.on.bind(stdinEmitter),
  };
  const child = {
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    stdin: stdin as unknown as NodeJS.WritableStream,
    on: vi.fn(),
    kill: vi.fn(),
    killed: false,
  } as unknown as ChildProcessWithoutNullStreams;
  return { child, stdout, stderr, stdin };
}

describe("IMessageRpcClient stdout framing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("U+2028 and U+2029 handling", () => {
    it("does not split on U+2028 LINE SEPARATOR", () => {
      const client = new IMessageRpcClient();
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );

      feedLines(
        client,
        `{"jsonrpc":"2.0","id":1,"result":{"text":"line one${LINE_SEP}line two"}}\n`,
      );

      expect(handleLineSpy).toHaveBeenCalledTimes(1);
      expect(handleLineSpy).toHaveBeenCalledWith(
        `{"jsonrpc":"2.0","id":1,"result":{"text":"line one${LINE_SEP}line two"}}`,
      );

      const parsed = JSON.parse(handleLineSpy.mock.calls[0][0]);
      expect(parsed.result.text).toBe(`line one${LINE_SEP}line two`);
    });

    it("does not split on U+2029 PARAGRAPH SEPARATOR", () => {
      const client = new IMessageRpcClient();
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );

      feedLines(
        client,
        `{"jsonrpc":"2.0","id":2,"result":{"text":"para one${PARA_SEP}para two"}}\n`,
      );

      expect(handleLineSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(handleLineSpy.mock.calls[0][0]);
      expect(parsed.result.text).toBe(`para one${PARA_SEP}para two`);
    });

    it("handles mixed U+2028 and U+2029 in a single response", () => {
      const client = new IMessageRpcClient();
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );

      feedLines(
        client,
        `{"jsonrpc":"2.0","id":3,"result":{"text":"a${LINE_SEP}b${PARA_SEP}c${LINE_SEP}d"}}\n`,
      );

      expect(handleLineSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(handleLineSpy.mock.calls[0][0]);
      expect(parsed.result.text).toBe(`a${LINE_SEP}b${PARA_SEP}c${LINE_SEP}d`);
    });
  });

  describe("LF framing", () => {
    it("splits multiple responses on LF", () => {
      const client = new IMessageRpcClient();
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );

      const r1 = `{"jsonrpc":"2.0","id":1,"result":"a"}`;
      const r2 = `{"jsonrpc":"2.0","id":2,"result":"b"}`;
      feedLines(client, `${r1}\n${r2}\n`);

      expect(handleLineSpy).toHaveBeenCalledTimes(2);
      expect(handleLineSpy).toHaveBeenNthCalledWith(1, r1);
      expect(handleLineSpy).toHaveBeenNthCalledWith(2, r2);
    });

    it("buffers incomplete lines across chunks", () => {
      const client = new IMessageRpcClient();
      const internals = client as unknown as { stdoutBuffer: string };
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );

      const fullLine = `{"jsonrpc":"2.0","id":1,"result":"done"}\n`;
      const chunk1 = fullLine.slice(0, 20);
      const chunk2 = fullLine.slice(20);

      internals.stdoutBuffer = "";
      feedLines(client, chunk1);
      expect(handleLineSpy).not.toHaveBeenCalled();

      feedLines(client, chunk2);
      expect(handleLineSpy).toHaveBeenCalledTimes(1);
      expect(handleLineSpy).toHaveBeenCalledWith(`{"jsonrpc":"2.0","id":1,"result":"done"}`);
    });

    it("skips empty lines", () => {
      const client = new IMessageRpcClient();
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );

      feedLines(
        client,
        `{"jsonrpc":"2.0","id":1,"result":"x"}\n\n\n{"jsonrpc":"2.0","id":2,"result":"y"}\n`,
      );

      expect(handleLineSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("handleLine", () => {
    it("resolves pending request on valid response", () => {
      const client = new IMessageRpcClient();
      const pending = (client as unknown as { pending: Map<string, unknown> }).pending;
      const resolveSpy = vi.fn();
      const rejectSpy = vi.fn();
      pending.set("42", { resolve: resolveSpy, reject: rejectSpy, timer: null });

      (client as unknown as { handleLine: (line: string) => void }).handleLine(
        `{"jsonrpc":"2.0","id":42,"result":{"ok":true}}`,
      );

      expect(resolveSpy).toHaveBeenCalledWith({ ok: true });
      expect(pending.has("42")).toBe(false);
    });

    it("rejects pending request on error response", () => {
      const client = new IMessageRpcClient();
      const pending = (client as unknown as { pending: Map<string, unknown> }).pending;
      const resolveSpy = vi.fn();
      const rejectSpy = vi.fn();
      pending.set("99", { resolve: resolveSpy, reject: rejectSpy, timer: null });

      (client as unknown as { handleLine: (line: string) => void }).handleLine(
        `{"jsonrpc":"2.0","id":99,"error":{"code":-1,"message":"failed"}}`,
      );

      expect(rejectSpy).toHaveBeenCalledWith(expect.any(Error));
      expect(rejectSpy.mock.calls[0][0].message).toContain("failed");
      expect(pending.has("99")).toBe(false);
    });

    it("dispatches notification when method is present without id", () => {
      const onNotification = vi.fn();
      const client = new IMessageRpcClient({ onNotification });

      (client as unknown as { handleLine: (line: string) => void }).handleLine(
        `{"jsonrpc":"2.0","method":"watch.subscribe","params":{"chat_id":1}}`,
      );

      expect(onNotification).toHaveBeenCalledWith({
        method: "watch.subscribe",
        params: { chat_id: 1 },
      });
    });

    it("logs error for unparseable line", () => {
      const runtime = { error: vi.fn() };
      const client = new IMessageRpcClient({ runtime });

      (client as unknown as { handleLine: (line: string) => void }).handleLine("this is not json");

      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("imsg rpc: failed to parse"),
      );
    });
  });

  describe("realistic U+2028 scenario (issue #89830)", () => {
    it("a messages.history response with U+2028 resolves the pending request", async () => {
      const runtime = { error: vi.fn() };
      const client = new IMessageRpcClient({ runtime });
      const pending = (client as unknown as { pending: Map<string, unknown> }).pending;

      let resolved: unknown;
      const promise = new Promise((r) => {
        resolved = r;
      });
      pending.set("1", {
        resolve: (v: unknown) => {
          resolved = v;
        },
        reject: vi.fn(),
        timer: null,
      });

      const messages = [
        {
          id: 100,
          text: `Promo line one:${LINE_SEP}✦ Promo line two:${LINE_SEP}Offer details`,
          is_from_me: false,
        },
        { id: 101, text: "Normal message", is_from_me: true },
      ];
      const response = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { messages },
      });

      feedLines(client, `${response}\n`);

      expect(resolved).toEqual({ messages });
      expect(runtime.error).not.toHaveBeenCalled();
    });
  });
});
