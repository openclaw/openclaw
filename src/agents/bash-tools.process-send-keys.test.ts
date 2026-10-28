import { Writable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { createManagedChildStdin } from "../process/supervisor/adapters/child-stdin.js";
import { addSession } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => resetProcessRegistryForTests());

test.each([
  { name: "raw hex", input: { hex: ["80", "ff", "00", "0x0a"] }, expected: "80ff000a" },
  {
    name: "mixed input with unknown cursor mode",
    input: { literal: "é", hex: ["c3", "a9", "zz"], keys: ["C-c", "Enter"] },
    expected: "c3a9c3a9030d",
  },
  { name: "invalid hex only", input: { hex: ["zz"] }, expected: "" },
])("send-keys preserves $name bytes", async ({ input, expected }) => {
  const received: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      received.push(chunk);
      callback();
    },
  });
  const stdin = createManagedChildStdin(stream)!;
  try {
    const session = createProcessSessionFixture({
      id: "input-bytes",
      command: "cat",
      cursorKeyMode: "unknown",
      backgrounded: true,
    });
    session.stdin = stdin;
    addSession(session);
    const result = await createProcessTool().execute("input-bytes", {
      action: "send-keys",
      sessionId: session.id,
      ...input,
    });
    expect(Buffer.concat(received).toString("hex")).toBe(expected);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        expected ? `Sent ${expected.length / 2} bytes` : "No key data provided.",
      ),
    });
    expect(result.details).toMatchObject({ status: expected ? "running" : "failed" });
  } finally {
    stream.destroy();
  }
});
