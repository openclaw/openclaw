import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

type MockChild = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  stdout?: EventEmitter;
  stderr?: EventEmitter;
  stdin?: { write: ReturnType<typeof vi.fn> };
};

const children: MockChild[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      status: 0,
      stdout: "BlackHole 2ch",
      stderr: "",
    })),
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        kill: vi.fn((signal?: NodeJS.Signals) => {
          child.signalCode = signal ?? "SIGTERM";
          return true;
        }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { write: vi.fn() },
      }) as MockChild;
      children.push(child);
      return child;
    }),
  };
});

describe("google-meet node host bridge sessions", () => {
  it("lists active bridge sessions and hides closed sessions", async () => {
    const { handleGoogleMeetNodeHostCommand } = await import("./src/node-host.js");
    const originalPlatform = process.platform;
    children.length = 0;

    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      const start = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "start",
            url: "https://meet.google.com/abc-defg-hij?authuser=1",
            mode: "realtime",
            launch: false,
            audioInputCommand: ["mock-rec"],
            audioOutputCommand: ["mock-play"],
          }),
        ),
      );

      expect(start).toMatchObject({
        audioBridge: { type: "node-command-pair" },
        bridgeId: expect.any(String),
      });

      const activeList = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "list",
            url: "https://meet.google.com/abc-defg-hij",
            mode: "realtime",
          }),
        ),
      );

      expect(activeList.bridges).toHaveLength(1);
      expect(activeList.bridges[0]).toMatchObject({
        bridgeId: start.bridgeId,
        closed: false,
        mode: "realtime",
        url: "https://meet.google.com/abc-defg-hij?authuser=1",
      });

      children[1]?.emit("exit", 0, null);

      const afterExitList = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "list",
            url: "https://meet.google.com/abc-defg-hij",
            mode: "realtime",
          }),
        ),
      );

      expect(afterExitList).toEqual({ bridges: [] });

      const stopped = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "stopByUrl",
            url: "https://meet.google.com/abc-defg-hij",
            mode: "realtime",
          }),
        ),
      );

      expect(stopped).toEqual({ ok: true, stopped: 0 });
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });
});
