import { finished } from "node:stream/promises";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientHarness } from "./test-support.js";

const prefix = '{"method":"item/commandExecution/outputDelta","params":{"delta":"';
const following = { method: "item/commandExecution/outputDelta", params: { delta: "following" } };
const notification = (delta: string) => ({
  method: "item/commandExecution/outputDelta",
  params: { delta },
});

describe("CodexAppServerClient message decoding", () => {
  const harnesses: ReturnType<typeof createClientHarness>[] = [];

  function createHarness() {
    const harness = createClientHarness({ autoEmitExit: false });
    harnesses.push(harness);
    const notifications: unknown[] = [];
    harness.client.addNotificationHandler((message) => {
      notifications.push(message);
    });
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    return { ...harness, notifications, warn };
  }

  afterEach(async () => {
    for (const harness of harnesses) {
      const drained = Promise.all([
        finished(harness.process.stdout, { cleanup: true }),
        finished(harness.process.stderr, { cleanup: true }),
      ]);
      for (const output of [harness.process.stdout, harness.process.stderr]) {
        output.end();
        output.resume();
      }
      await drained;
      harness.emitExit();
      await expect(harness.client.closeAndWait()).resolves.toMatchObject({ exited: true });
    }
    harnesses.length = 0;
    vi.restoreAllMocks();
  });

  it("delivers the final stdout frame at EOF without a trailing newline", async () => {
    const harness = createHarness();
    harness.process.stdout.end(JSON.stringify(following));
    await finished(harness.process.stdout, { cleanup: true });

    expect(harness.notifications).toEqual([following]);
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it("drops later frames in the same chunk when a notification handler closes the client", async () => {
    const harness = createHarness();
    const pending = harness.client.request("model/list", {});
    harness.client.addNotificationHandler(() => harness.client.close());

    harness.process.stdout.write(
      `${JSON.stringify(notification("close"))}\n${JSON.stringify(following)}\n${prefix}partial`,
    );

    await expect(pending).rejects.toThrow("codex app-server client is closed");
    expect(harness.notifications).toEqual([notification("close")]);
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it("preserves child errors while discarding an incomplete stdout frame", async () => {
    const harness = createHarness();
    const pending = harness.client.request("model/list", {});
    harness.process.stdout.write(`${prefix}partial`);

    harness.process.emit("error", new Error("synthetic child transport failure"));
    harness.process.stdout.write(`"}}\n${JSON.stringify(following)}\n`);

    await expect(pending).rejects.toThrow("synthetic child transport failure");
    await expect(harness.client.request("model/list", {})).rejects.toThrow(
      "synthetic child transport failure",
    );
    expect(harness.notifications).toEqual([]);
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it("preserves whitespace, escapes, and byte-split UTF-8 with CRLF framing", () => {
    const harness = createHarness();
    const delta = ' first "quoted" \n\npath C:\\synthetic\\\nunicode a 😀 猫 😀 \n\n';
    const bytes = Buffer.from(` \t\r\n  ${JSON.stringify(notification(delta))}\r\n`);
    for (let offset = 0; offset < bytes.length; offset++) {
      harness.process.stdout.write(bytes.subarray(offset, offset + 1));
    }
    harness.process.stdout.write(`\u00a0${JSON.stringify(following)}\u00a0\n`);

    expect(harness.notifications).toEqual([notification(delta), following]);
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it.each([
    String.raw`bad \q`,
    String.raw`bad \u12`,
    "bad\tvalue",
    'first"}} trailing',
    'first","bad": @ "unfinished',
  ])("drops malformed frames without consuming the next valid frame: %s", (delta) => {
    const harness = createHarness();
    harness.process.stdout.write(
      `{"method":"item/commandExecution/outputDelta","params":{"token":"synthetic-secret","delta":"${delta}\n`,
    );
    harness.send(following);

    expect(harness.notifications).toEqual([following]);
    expect(harness.warn).toHaveBeenCalledExactlyOnceWith(
      "failed to parse codex app-server message",
      expect.objectContaining({ error: expect.any(SyntaxError), fragmentCount: 1 }),
    );
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain("synthetic-secret");
    expect(JSON.stringify(harness.warn.mock.calls)).toContain("<redacted>");
  });
});
