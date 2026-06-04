import { afterEach, describe, expect, it, vi } from "vitest";
import { IMessageRpcClient } from "./client.js";

const LINE_SEP = "\u2028";
const PARA_SEP = "\u2029";

function feedChunks(client: IMessageRpcClient, ...chunks: string[]): void {
  const internals = client as unknown as {
    stdoutBuffer: string;
    handleLine: (line: string) => void;
  };
  for (const chunk of chunks) {
    internals.stdoutBuffer += chunk;
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
}

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
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

      const textWithLineSep = "line one" + LINE_SEP + "line two";
      const response = '{"jsonrpc":"2.0","id":1,"result":{"text":"' + textWithLineSep + '"}}\n';

      feedChunks(client, response);

      expect(handleLineSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(handleLineSpy.mock.calls[0][0]);
      expect(parsed.result.text).toBe(textWithLineSep);
    });

    it("does not split on U+2029 PARAGRAPH SEPARATOR", () => {
      const client = new IMessageRpcClient();
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );

      const textWithParaSep = "para one" + PARA_SEP + "para two";
      const response = '{"jsonrpc":"2.0","id":2,"result":{"text":"' + textWithParaSep + '"}}\n';

      feedChunks(client, response);

      expect(handleLineSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(handleLineSpy.mock.calls[0][0]);
      expect(parsed.result.text).toBe(textWithParaSep);
    });

    it("handles mixed U+2028 and U+2029 in a single response", () => {
      const client = new IMessageRpcClient();
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );

      const textMixed = "a" + LINE_SEP + "b" + PARA_SEP + "c" + LINE_SEP + "d";
      const response = '{"jsonrpc":"2.0","id":3,"result":{"text":"' + textMixed + '"}}\n';

      feedChunks(client, response);

      expect(handleLineSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(handleLineSpy.mock.calls[0][0]);
      expect(parsed.result.text).toBe(textMixed);
    });
  });

  describe("LF framing", () => {
    it("splits multiple responses on LF", () => {
      const client = new IMessageRpcClient();
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );

      const r1 = '{"jsonrpc":"2.0","id":1,"result":"a"}';
      const r2 = '{"jsonrpc":"2.0","id":2,"result":"b"}';
      feedChunks(client, r1 + "\n" + r2 + "\n");

      expect(handleLineSpy).toHaveBeenCalledTimes(2);
      expect(handleLineSpy).toHaveBeenNthCalledWith(1, r1);
      expect(handleLineSpy).toHaveBeenNthCalledWith(2, r2);
    });

    it("buffers incomplete lines across chunks", () => {
      const client = new IMessageRpcClient();
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );

      const fullLine = '{"jsonrpc":"2.0","id":1,"result":"done"}\n';
      const chunk1 = fullLine.slice(0, 20);
      const chunk2 = fullLine.slice(20);

      feedChunks(client, chunk1, chunk2);

      expect(handleLineSpy).toHaveBeenCalledTimes(1);
      expect(handleLineSpy).toHaveBeenCalledWith('{"jsonrpc":"2.0","id":1,"result":"done"}');
    });

    it("skips empty lines", () => {
      const client = new IMessageRpcClient();
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );

      feedChunks(
        client,
        '{"jsonrpc":"2.0","id":1,"result":"x"}\n\n\n{"jsonrpc":"2.0","id":2,"result":"y"}\n',
      );

      expect(handleLineSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("lifecycle (shutdown race #89883)", () => {
    it("clears listener and buffer on stop so late stdout does not crash", () => {
      const client = new IMessageRpcClient();
      const handleLineSpy = vi.spyOn(
        client as unknown as { handleLine: (line: string) => void },
        "handleLine",
      );
      const internals = client as unknown as {
        stdoutBuffer: string;
        stdoutDataListener: ((chunk: string) => void) | null;
        handleLine: (line: string) => void;
      };

      const listener = (chunk: string) => {
        internals.stdoutBuffer += chunk;
        let idx: number;
        while ((idx = internals.stdoutBuffer.indexOf("\n")) !== -1) {
          const line = internals.stdoutBuffer.slice(0, idx);
          internals.stdoutBuffer = internals.stdoutBuffer.slice(idx + 1);
          const trimmed = line.trim();
          if (trimmed) {
            internals.handleLine(trimmed);
          }
        }
      };

      internals.stdoutDataListener = listener;
      internals.stdoutBuffer = "";

      listener('{"jsonrpc":"2.0","id":1,"result":"before"}\n');
      expect(handleLineSpy).toHaveBeenCalledTimes(1);

      internals.stdoutDataListener = null;
      internals.stdoutBuffer = "";

      expect(internals.stdoutDataListener).toBeNull();
      expect(internals.stdoutBuffer).toBe("");

      expect(() => {
        feedChunks(client, '{"jsonrpc":"2.0","id":2,"result":"after"}\n');
      }).not.toThrow();
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
        '{"jsonrpc":"2.0","id":42,"result":{"ok":true}}',
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
        '{"jsonrpc":"2.0","id":99,"error":{"code":-1,"message":"failed"}}',
      );

      expect(rejectSpy).toHaveBeenCalledWith(expect.any(Error));
      expect(rejectSpy.mock.calls[0][0].message).toContain("failed");
      expect(pending.has("99")).toBe(false);
    });

    it("dispatches notification when method is present without id", () => {
      const onNotification = vi.fn();
      const client = new IMessageRpcClient({ onNotification });

      (client as unknown as { handleLine: (line: string) => void }).handleLine(
        '{"jsonrpc":"2.0","method":"watch.subscribe","params":{"chat_id":1}}',
      );

      expect(onNotification).toHaveBeenCalledWith({
        method: "watch.subscribe",
        params: { chat_id: 1 },
      });
    });

    it("logs error for unparseable line", () => {
      const runtime = makeRuntime();
      const client = new IMessageRpcClient({ runtime });

      (client as unknown as { handleLine: (line: string) => void }).handleLine("this is not json");

      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("imsg rpc: failed to parse"),
      );
    });
  });

  describe("realistic U+2028 scenario (issue #89830)", () => {
    it("a messages.history response with U+2028 resolves the pending request", () => {
      const runtime = makeRuntime();
      const client = new IMessageRpcClient({ runtime });
      const pending = (client as unknown as { pending: Map<string, unknown> }).pending;

      const resolveSpy = vi.fn();
      pending.set("1", { resolve: resolveSpy, reject: vi.fn(), timer: null });

      const messages = [
        {
          id: 100,
          text: "Promo line one:" + LINE_SEP + "✦ Promo line two:" + LINE_SEP + "Offer details",
          is_from_me: false,
        },
        { id: 101, text: "Normal message", is_from_me: true },
      ];
      const response = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { messages } }) + "\n";

      feedChunks(client, response);

      expect(resolveSpy).toHaveBeenCalledWith({ messages });
      expect(runtime.error).not.toHaveBeenCalled();
    });
  });
});
