import { afterEach, expect, test, vi } from "vitest";
import { addSession, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

const payload = "你好🙂";

async function expectUtf8ByteCount(testCase: {
  id: string;
  args: { action: "write"; data: string } | { action: "send-keys"; literal: string };
  verb: string;
}) {
  const write = vi.fn((data: string, callback?: (error?: Error | null) => void) => {
    callback?.(null);
  });
  const session = createProcessSessionFixture({
    id: testCase.id,
    backgrounded: true,
    cursorKeyMode: "normal",
  });
  session.stdin = { write, end: vi.fn(), destroyed: false };
  addSession(session);

  const result = await createProcessTool().execute("toolcall", {
    ...testCase.args,
    sessionId: testCase.id,
  });

  expect(write).toHaveBeenCalledWith(payload, expect.any(Function));
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: `${testCase.verb} 10 bytes to session ${testCase.id}.`,
  });
}

test("process write reports UTF-8 byte counts", async () => {
  expect(payload).toHaveLength(4);
  expect(Buffer.byteLength(payload, "utf8")).toBe(10);

  await expectUtf8ByteCount({
    id: "write-unicode",
    args: { action: "write", data: payload },
    verb: "Wrote",
  });
});

test("process send-keys reports UTF-8 byte counts", async () => {
  await expectUtf8ByteCount({
    id: "send-keys-unicode",
    args: { action: "send-keys", literal: payload },
    verb: "Sent",
  });
});
