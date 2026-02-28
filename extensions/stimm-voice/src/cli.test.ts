import { describe, expect, it, vi } from "vitest";
import { registerStimmVoiceCli } from "./cli.js";
import type { StimmVoiceConfig } from "./config.js";

type VoiceSession = {
  roomName: string;
  clientToken: string;
  createdAt: number;
  originChannel: string;
  supervisor: { connected: boolean };
  shareUrl?: string;
  claimToken?: string;
};

type RoomManager = {
  createSession: (opts: { roomName?: string; originChannel: string }) => Promise<VoiceSession>;
  endSession: (room: string) => Promise<boolean>;
  listSessions: () => VoiceSession[];
  getSession: (room: string) => VoiceSession | undefined;
  stopAll: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ActionFn = (opts: Record<string, unknown>) => Promise<void>;

function fakeProgram() {
  const commands: Record<string, { description: string; options: string[]; action?: ActionFn }> =
    {};
  return {
    commands,
    command(name: string) {
      const entry = {
        description: "",
        options: [] as string[],
        action: undefined as ActionFn | undefined,
      };
      commands[name] = entry;
      const chain = {
        description(d: string) {
          entry.description = d;
          return chain;
        },
        option(flags: string, _desc: string, _defaultValue?: string) {
          entry.options.push(flags);
          return chain;
        },
        action(fn: ActionFn) {
          entry.action = fn;
          return chain;
        },
      };
      return chain;
    },
  };
}

function fakeSession(overrides: Partial<VoiceSession> = {}): VoiceSession {
  return {
    roomName: "test-room",
    clientToken: "fake-token",
    createdAt: Date.now(),
    originChannel: "web",
    supervisor: { connected: true } as VoiceSession["supervisor"],
    ...overrides,
  };
}

function fakeRoomManager(sessions: VoiceSession[] = []): RoomManager {
  return {
    createSession: vi.fn(async (opts: { roomName?: string; originChannel: string }) => {
      return fakeSession({
        roomName: opts.roomName ?? "auto-room",
        originChannel: opts.originChannel,
      });
    }),
    endSession: vi.fn(async (room: string) => sessions.some((s) => s.roomName === room)),
    listSessions: vi.fn(() => sessions),
    getSession: vi.fn((room: string) => sessions.find((s) => s.roomName === room)),
    stopAll: vi.fn(async () => {}),
  } as unknown as RoomManager;
}

const enabledConfig = {
  enabled: true,
  livekit: { url: "ws://localhost:7880", apiKey: "k", apiSecret: "s" },
  voiceAgent: {} as StimmVoiceConfig["voiceAgent"],
  web: { enabled: true, path: "/voice" },
} as StimmVoiceConfig;

const disabledConfig = { ...enabledConfig, enabled: false };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerStimmVoiceCli", () => {
  it("registers voice, voice:start, voice:stop, voice:status commands", () => {
    const prog = fakeProgram();
    const rm = fakeRoomManager();
    registerStimmVoiceCli({
      program: prog as any,
      config: enabledConfig,
      ensureRuntime: async () => ({ roomManager: rm }),
      logger: { info: vi.fn(), error: vi.fn() },
    });

    expect(prog.commands).toHaveProperty("voice");
    expect(prog.commands).toHaveProperty("voice:start");
    expect(prog.commands).toHaveProperty("voice:stop");
    expect(prog.commands).toHaveProperty("voice:status");
    expect(prog.commands).toHaveProperty("voice:logs");
  });

  it("voice:start creates a session and logs info", async () => {
    const prog = fakeProgram();
    const logger = { info: vi.fn(), error: vi.fn() };
    const rm = fakeRoomManager();
    registerStimmVoiceCli({
      program: prog as any,
      config: enabledConfig,
      ensureRuntime: async () => ({ roomManager: rm }),
      logger,
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await prog.commands["voice:start"].action!({ channel: "web" });
    exitSpy.mockRestore();
    expect(rm.createSession).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Voice session started"));
  });

  it("voice:start logs share URL flow when session has web access link", async () => {
    const prog = fakeProgram();
    const logger = { info: vi.fn(), error: vi.fn() };
    const rm = fakeRoomManager() as unknown as RoomManager;
    vi.mocked(rm.createSession).mockResolvedValueOnce(
      fakeSession({
        roomName: "share-room",
        shareUrl: "https://example.trycloudflare.com/voice?claim=abc",
        claimToken: "abc",
      }),
    );

    registerStimmVoiceCli({
      program: prog as any,
      config: enabledConfig,
      ensureRuntime: async () => ({ roomManager: rm }),
      logger,
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await prog.commands["voice:start"].action!({ channel: "web" });
    exitSpy.mockRestore();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Share URL: https://example.trycloudflare.com/voice?claim=abc"),
    );
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Claim token: abc"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Scan this QR code"));
  });

  it("voice:start refuses when disabled", async () => {
    const prog = fakeProgram();
    const logger = { info: vi.fn(), error: vi.fn() };
    const rm = fakeRoomManager();
    registerStimmVoiceCli({
      program: prog as any,
      config: disabledConfig,
      ensureRuntime: async () => ({ roomManager: rm }),
      logger,
    });

    await prog.commands["voice:start"].action!({ channel: "web" });
    expect(rm.createSession).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("voice:stop errors without --room", async () => {
    const prog = fakeProgram();
    const logger = { info: vi.fn(), error: vi.fn() };
    const rm = fakeRoomManager();
    registerStimmVoiceCli({
      program: prog as any,
      config: enabledConfig,
      ensureRuntime: async () => ({ roomManager: rm }),
      logger,
    });

    await prog.commands["voice:stop"].action!({ room: undefined as any });
    expect(logger.error).toHaveBeenCalledWith("--room is required");
  });

  it("voice:status shows no sessions message when empty", async () => {
    const prog = fakeProgram();
    const logger = { info: vi.fn(), error: vi.fn() };
    const rm = fakeRoomManager([]);
    registerStimmVoiceCli({
      program: prog as any,
      config: enabledConfig,
      ensureRuntime: async () => ({ roomManager: rm }),
      logger,
    });

    await prog.commands["voice:status"].action!({});
    expect(logger.info).toHaveBeenCalledWith("No active voice sessions.");
  });

  it("voice:status lists active sessions", async () => {
    const prog = fakeProgram();
    const logger = { info: vi.fn(), error: vi.fn() };
    const sessions = [
      fakeSession({ roomName: "room-a", originChannel: "web" }),
      fakeSession({ roomName: "room-b", originChannel: "telegram" }),
    ];
    const rm = fakeRoomManager(sessions);
    registerStimmVoiceCli({
      program: prog as any,
      config: enabledConfig,
      ensureRuntime: async () => ({ roomManager: rm }),
      logger,
    });

    await prog.commands["voice:status"].action!({});
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("room-a"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("room-b"));
  });
});
