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

  it.each([
    {
      name: "spaces, empty fragments, escapes, and split UTF-8 with CRLF framing",
      fragments: [
        String.raw` first \"quoted\" `,
        "",
        String.raw`path C:\\synthetic\\`,
        String.raw`unicode \u0061 \uD83D\uDE00 猫 😀 `,
        "",
        "",
      ],
      delta: ' first "quoted" \n\npath C:\\synthetic\\\nunicode a 😀 猫 😀 \n\n',
      separator: "\r\n",
    },
    {
      name: "trailing backslash",
      fragments: ["first \\", "second"],
      delta: "first \\nsecond",
      separator: "\n",
    },
  ])("preserves $name while recovering raw-newline strings", ({ fragments, delta, separator }) => {
    const harness = createHarness();
    const bytes = Buffer.from(` \t\n  ${prefix}${fragments.join(separator)}"}}${separator}`);
    for (let offset = 0; offset < bytes.length; offset++) {
      harness.process.stdout.write(bytes.subarray(offset, offset + 1));
    }
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

  it("recovers raw newlines in object keys without discarding the next frame", () => {
    const harness = createHarness();
    harness.process.stdout.write(`${prefix}first","extra\nkey":"value"}}\n`);
    harness.send(following);

    expect(harness.notifications).toEqual([
      { ...notification("first"), params: { delta: "first", "extra\nkey": "value" } },
      following,
    ]);
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it.each([
    { name: "invalid escape", fragments: ["first", String.raw`bad \q`] },
    { name: "incomplete Unicode escape", fragments: ["first", String.raw`bad \u12`] },
    { name: "unescaped control", fragments: ["first", "bad\tvalue"] },
    { name: "initial trailing control", fragments: ["bad\t"] },
    { name: "invalid completed frame", fragments: ["first", 'second"}} trailing'] },
    { name: "invalid syntax before open string", fragments: ['first","bad": @ "unfinished'] },
  ])("resynchronizes after $name", ({ fragments }) => {
    const harness = createHarness();
    harness.process.stdout.write(
      `{"method":"item/commandExecution/outputDelta","params":{"token":"synthetic-secret","delta":"${fragments.join("\n")}\n`,
    );
    harness.send(following);
    expect(harness.notifications).toEqual([following]);
    expect(harness.warn).toHaveBeenCalledExactlyOnceWith(
      "failed to parse codex app-server message",
      expect.objectContaining({ error: expect.any(SyntaxError), fragmentCount: fragments.length }),
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
