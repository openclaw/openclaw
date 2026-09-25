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

  it("dispatches interleaved responses, notifications, and server requests in stdout order", async () => {
    const harness = createHarness();
    const observed: string[] = [];
    harness.client.addNotificationHandler((message) => {
      observed.push(message.method);
    });
    harness.client.addRequestHandler((request) => {
      observed.push(request.method);
      return { decision: "decline" };
    });
    const first = harness.client.request(
      "thread/list",
      {},
      {
        attemptWaiterFinished: () => observed.push("first response"),
      },
    );
    const second = harness.client.request(
      "thread/list",
      {},
      {
        attemptWaiterFinished: () => observed.push("second response"),
      },
    );
    const firstId = JSON.parse(await harness.waitForWrite(0)).id;
    const secondId = JSON.parse(await harness.waitForWrite(1)).id;
    const frames = [
      { method: "turn/started", params: { threadId: "thread-1" } },
      { id: secondId, result: { data: [{ id: "second" }] } },
      {
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1" },
      },
      { method: "item/agentMessage/delta", params: { delta: "hello" } },
      { id: firstId, result: { data: [{ id: "first" }] } },
      { method: "turn/completed", params: { threadId: "thread-1" } },
    ];

    harness.process.stdout.write(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);

    expect(observed).toEqual([
      "turn/started",
      "second response",
      "item/commandExecution/requestApproval",
      "item/agentMessage/delta",
      "first response",
      "turn/completed",
    ]);
    await expect(first).resolves.toEqual({ data: [{ id: "first" }] });
    await expect(second).resolves.toEqual({ data: [{ id: "second" }] });
    expect(JSON.parse(await harness.waitForWrite(2))).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it.each(["\n", "\r\n"])(
    "preserves split UTF-8 and raw-newline recovery with %j framing",
    (separator) => {
      const harness = createHarness();
      const bytes = Buffer.from(
        `${prefix}猫${separator}😀"}}${separator}${JSON.stringify(following)}${separator}`,
      );
      for (let offset = 0; offset < bytes.length; offset++) {
        harness.process.stdout.write(bytes.subarray(offset, offset + 1));
      }

      expect(harness.notifications).toEqual([notification("猫\n😀"), following]);
      expect(harness.warn).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    { name: "plain text", fragments: ["first", "second"], delta: "first\nsecond" },
    { name: "trailing spaces", fragments: ["first ", " second "], delta: "first \n second " },
    { name: "empty fragments", fragments: ["", "middle", "", ""], delta: "\nmiddle\n\n" },
    {
      name: "escaped quotes, backslashes, and Unicode",
      fragments: [
        String.raw`first \"quoted\"`,
        String.raw`path C:\\synthetic\\`,
        String.raw`unicode \u0061 \uD83D\uDE00`,
      ],
      delta: 'first "quoted"\npath C:\\synthetic\\\nunicode a 😀',
    },
    { name: "trailing backslash", fragments: ["first \\", "second"], delta: "first \\nsecond" },
    {
      name: "large text",
      fragments: ["x".repeat(1_100_000), "second"],
      delta: `${"x".repeat(1_100_000)}\nsecond`,
    },
  ])("preserves $name while recovering raw-newline strings", ({ fragments, delta }) => {
    const harness = createHarness();
    harness.process.stdout.write(` \t\n  ${prefix}${fragments.join("\n")}"}}\n`);
    harness.process.stdout.write(`\u00a0${JSON.stringify(following)}\u00a0\n`);
    expect(harness.notifications).toEqual([notification(delta), following]);
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it("bounds cumulative parse input for a fragmented message without delaying delivery", () => {
    const harness = createHarness();
    const fragments = Array.from({ length: 64 }, () => "x".repeat(128));
    const frame = `${prefix}${fragments.join("\n")}"}}\n`;
    const nativeParse = JSON.parse;
    let attemptedBytes = 0;
    const parse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      attemptedBytes += Buffer.byteLength(text);
      return nativeParse(text, reviver);
    });
    try {
      harness.process.stdout.write(frame);
    } finally {
      parse.mockRestore();
    }
    expect(harness.notifications).toEqual([notification(fragments.join("\n"))]);
    harness.send(following);
    expect(harness.notifications).toEqual([notification(fragments.join("\n")), following]);
    expect(harness.warn).not.toHaveBeenCalled();
    expect(attemptedBytes).toBeLessThanOrEqual(4 * Buffer.byteLength(frame));
  });

  it.each([
    { name: "invalid escape", fragment: String.raw`bad \q` },
    { name: "incomplete Unicode escape", fragment: String.raw`bad \u12` },
    { name: "invalid Unicode escape", fragment: String.raw`bad \u123x` },
    { name: "unescaped control", fragment: "bad\tvalue" },
    { name: "invalid completed frame", fragment: 'second"}} trailing' },
  ])("resynchronizes after a recovered $name", ({ fragment }) => {
    const harness = createHarness();
    harness.process.stdout.write(
      '{"method":"item/commandExecution/outputDelta","params":{"token":"synthetic-secret","delta":"first\n',
    );
    harness.process.stdout.write(`${fragment}\n`);
    harness.send(following);
    expect(harness.notifications).toEqual([following]);
    expect(harness.warn).toHaveBeenCalledExactlyOnceWith(
      "failed to parse codex app-server message",
      expect.objectContaining({ error: expect.any(SyntaxError), fragmentCount: 2 }),
    );
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain("synthetic-secret");
    expect(JSON.stringify(harness.warn.mock.calls)).toContain("<redacted>");
  });

  it.each([
    { bound: "length", complete: true },
    { bound: "length", complete: false },
    { bound: "lines", complete: true },
    { bound: "lines", complete: false },
  ])("retains the $bound recovery bound (complete: $complete)", ({ bound, complete }) => {
    const harness = createHarness();
    const fragments =
      bound === "length"
        ? ["x".repeat(8 * 1024 * 1024 - prefix.length - 3), "x"]
        : Array.from({ length: 1_000 }, () => "x");
    harness.process.stdout.write(`${prefix}${fragments.join("\n")}\n`);
    expect(harness.notifications).toEqual([]);
    expect(harness.warn).not.toHaveBeenCalled();
    harness.process.stdout.write(complete ? 'last"}}\n' : "continuation\n");
    harness.send(following);
    if (complete) {
      expect(harness.notifications).toEqual([
        notification(`${fragments.join("\n")}\nlast`),
        following,
      ]);
      expect(harness.warn).not.toHaveBeenCalled();
    } else {
      expect(harness.notifications).toEqual([following]);
      expect(harness.warn).toHaveBeenCalledExactlyOnceWith(
        "failed to parse codex app-server message",
        expect.objectContaining({ fragmentCount: fragments.length + 1 }),
      );
    }
  });
});
