// stdout and stderr are independent pipes, so decode state must not be shared:
// a pending sequence on one stream must never consume the other's output.
// Operations are injected (no real spawn) so the byte boundaries are exact and
// the suite stays isolated from sibling process-mock tests in the same shard.
import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "./bash-executor.js";
import type { BashOperations, BashOutputStream } from "./tools/bash-operations.js";

const ESC = "\u001B";
const BEL = "\u0007";

/** Replays the given tagged chunks through a single executor run. */
const runChunks = (chunks: ReadonlyArray<[Buffer, BashOutputStream?]>) => {
  const operations: BashOperations = {
    exec: async (_command, _cwd, options) => {
      for (const [data, stream] of chunks) {
        options.onData(data, stream);
      }
      return { exitCode: 0 };
    },
  };
  return executeBashWithOperations("printf isolated", "/tmp", operations);
};

describe("executeBashWithOperations stream isolation", () => {
  it("keeps stderr visible while stdout holds an unterminated OSC", async () => {
    // The OSC parser discards input until a terminator; sharing it across pipes
    // silently swallowed everything stderr wrote in that window.
    const result = await runChunks([
      [Buffer.from(`${ESC}]0;sometitle`), "stdout"], // unterminated OSC on stdout
      [Buffer.from("STDERR_VISIBLE_LINE\n"), "stderr"],
      [Buffer.from(`${BEL}AFTER_OSC\n`), "stdout"], // BEL terminates the OSC
    ]);

    expect(result.output).toContain("STDERR_VISIBLE_LINE");
    expect(result.output).toContain("AFTER_OSC");
  });

  it("decodes a multi-byte character split across chunks when stderr interleaves", async () => {
    // The leading bytes of U+65E5 land on stdout; an stderr write arrives before
    // the trailing byte. A shared TextDecoder folds the other stream's byte into
    // the pending character and corrupts it.
    const result = await runChunks([
      [Buffer.from([0xe6, 0x97]), "stdout"], // leading bytes of 日
      [Buffer.from("E"), "stderr"], // lands mid-character on the other pipe
      [Buffer.from([0xa5]), "stdout"],
    ]);

    expect(result.output).toContain("日");
    expect(result.output).not.toContain("�");
  });

  it("strips a CSI sequence split across chunks on each tagged stream", async () => {
    const result = await runChunks([
      [Buffer.from(`${ESC}[`), "stdout"],
      [Buffer.from(`${ESC}[`), "stderr"],
      [Buffer.from("31mOUT"), "stdout"],
      [Buffer.from("32mERR"), "stderr"],
    ]);

    expect(result.output).toBe("OUTERR");
  });

  it("keeps one shared lane for untagged chunks", async () => {
    // Operations that cannot distinguish pipes still get today's behavior: a
    // sequence may span consecutive untagged callbacks.
    const result = await runChunks([[Buffer.from(`${ESC}[`)], [Buffer.from("31mLEGACY")]]);

    expect(result.output).toBe("LEGACY");
  });
});
