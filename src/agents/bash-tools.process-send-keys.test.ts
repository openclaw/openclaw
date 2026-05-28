import { expect, test } from "vitest";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { handleProcessSendKeys, type WritableStdin } from "./bash-tools.process-send-keys.js";

const fakeSecretOutput = "OPENAI_API_KEY=sk-proj-redaction-canary-1234567890";
const fakeFlagSecret = "sk-proj-redaction-canary-abcdefghijklmnopqrstuvwxyz1234567890";

function createWritableStdinStub(): WritableStdin {
  return {
    write(dataValue: string, cb?: (err?: Error | null) => void) {
      cb?.();
    },
    end() {},
    destroyed: false,
  };
}

function expectTextContent(content: unknown, text: string) {
  const part = content as { type?: string; text?: string } | undefined;
  expect(part?.type).toBe("text");
  expect(part?.text).toContain(text);
}

test("process send-keys fails loud for unknown cursor mode when arrows depend on it", async () => {
  const result = await handleProcessSendKeys({
    sessionId: "sess-unknown-mode",
    session: createProcessSessionFixture({
      id: "sess-unknown-mode",
      command: "vim",
      backgrounded: true,
      cursorKeyMode: "unknown",
    }),
    stdin: createWritableStdinStub(),
    keys: ["up"],
  });

  expect((result.details as { status?: string }).status).toBe("failed");
  expectTextContent(result.content[0], "cursor key mode is not known yet");
});

test("process send-keys still sends non-cursor keys while mode is unknown", async () => {
  const result = await handleProcessSendKeys({
    sessionId: "sess-unknown-enter",
    session: createProcessSessionFixture({
      id: "sess-unknown-enter",
      command: "vim",
      backgrounded: true,
      cursorKeyMode: "unknown",
    }),
    stdin: createWritableStdinStub(),
    keys: ["Enter"],
  });

  expect((result.details as { status?: string }).status).toBe("running");
});

test("process send-keys redacts secret-shaped command-derived details name", async () => {
  const result = await handleProcessSendKeys({
    sessionId: "sess-redact-send-keys-name",
    session: createProcessSessionFixture({
      id: "sess-redact-send-keys-name",
      command: `echo ${fakeSecretOutput}`,
      backgrounded: true,
    }),
    stdin: createWritableStdinStub(),
    keys: ["Enter"],
  });
  const details = result.details as { name?: string };

  expect((result.content[0] as { text?: string }).text).not.toContain(fakeSecretOutput);
  expect(JSON.stringify(details)).not.toContain(fakeSecretOutput);
  expect(details.name).toContain("OPENAI_API_KEY=");
});

test("process send-keys redacts secret-shaped flag values before deriving details name", async () => {
  const result = await handleProcessSendKeys({
    sessionId: "sess-redact-send-keys-flag-name",
    session: createProcessSessionFixture({
      id: "sess-redact-send-keys-flag-name",
      command: `tool --api-key ${fakeFlagSecret}`,
      backgrounded: true,
    }),
    stdin: createWritableStdinStub(),
    keys: ["Enter"],
  });
  const details = result.details as { name?: string };

  expect(JSON.stringify(details)).not.toContain(fakeFlagSecret);
  expect(JSON.stringify(details)).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
  expect(details.name).toContain("sk-pro…7890");
});
