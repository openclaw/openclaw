import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool, OpenClawPluginService } from "../../src/plugin-sdk/plugin-entry.js";
import { createTestPluginApi } from "../../src/plugin-sdk/plugin-test-api.js";
import { MeetingNotesStore } from "./src/store.js";

const { getMeetingNotesSourceProviderMock } = vi.hoisted(() => ({
  getMeetingNotesSourceProviderMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/meeting-notes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/plugin-sdk/meeting-notes.js")>();
  return {
    ...actual,
    getMeetingNotesSourceProvider: getMeetingNotesSourceProviderMock,
  };
});

vi.mock("../../src/plugin-sdk/meeting-notes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/plugin-sdk/meeting-notes.js")>();
  return {
    ...actual,
    getMeetingNotesSourceProvider: getMeetingNotesSourceProviderMock,
  };
});

async function makeStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
}

function currentDateDir(): string {
  return new Date().toISOString().slice(0, 10);
}

async function createHarness(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const providers: unknown[] = [];
  const tools: AnyAgentTool[] = [];
  const services: OpenClawPluginService[] = [];
  const cliRegistrars: Array<{
    registrar: unknown;
    opts: unknown;
  }> = [];
  const api = createTestPluginApi({
    pluginConfig,
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
    } as never,
    registerMeetingNotesSourceProvider: (provider) => providers.push(provider),
    registerTool: (tool) => tools.push(tool as AnyAgentTool),
    registerService: (service) => services.push(service),
    registerCli: (registrar, opts) => cliRegistrars.push({ registrar, opts }),
  });
  const { default: meetingNotesPlugin } = await import("./index.js");
  meetingNotesPlugin.register(api);
  return { cliRegistrars, providers, services, tool: tools[0] };
}

describe("meeting-notes plugin", () => {
  beforeEach(() => {
    getMeetingNotesSourceProviderMock.mockReset();
  });

  it("registers the manual transcript source and tool", async () => {
    const stateDir = await makeStateDir();
    const { cliRegistrars, providers, tool } = await createHarness(stateDir);

    expect(providers).toHaveLength(1);
    expect(tool?.name).toBe("meeting_notes");
    expect(cliRegistrars[0]?.opts).toMatchObject({
      descriptors: [{ name: "meeting-notes", hasSubcommands: true }],
    });
  });

  it("imports a speaker transcript and writes summary artifacts", async () => {
    const stateDir = await makeStateDir();
    const { tool } = await createHarness(stateDir);

    const result = await tool.execute(
      "call-1",
      {
        action: "import",
        providerId: "manual-transcript",
        sessionId: "design-review",
        title: "Design review",
        transcript:
          "Alex: We decided to ship Discord first.\nSam: Action item: add Slack import later.",
      },
      undefined,
      vi.fn(),
    );

    expect(result).toMatchObject({
      details: {
        sessionId: "design-review",
        utteranceCount: 2,
      },
    });
    await expect(
      fs.readFile(
        path.join(stateDir, "meeting-notes", currentDateDir(), "design-review", "summary.md"),
        "utf8",
      ),
    ).resolves.toContain("Action item: add Slack import later.");
    await expect(
      fs.readFile(
        path.join(stateDir, "meeting-notes", currentDateDir(), "design-review", "transcript.jsonl"),
        "utf8",
      ),
    ).resolves.toContain("Alex");
  });

  it("bounds summary input while retaining the full transcript", async () => {
    const stateDir = await makeStateDir();
    const { tool } = await createHarness(stateDir, { maxUtterances: 1 });

    await tool.execute(
      "call-1",
      {
        action: "import",
        providerId: "manual-transcript",
        sessionId: "long-meeting",
        title: "Long meeting",
        transcript:
          "Alex: Action item: write the first draft.\nSam: Decision: ship the final plan.",
      },
      undefined,
      vi.fn(),
    );

    const summary = await fs.readFile(
      path.join(stateDir, "meeting-notes", currentDateDir(), "long-meeting", "summary.md"),
      "utf8",
    );
    expect(summary).toContain("Decision: ship the final plan.");
    expect(summary).not.toContain("Action item: write the first draft.");
    const transcript = await fs.readFile(
      path.join(stateDir, "meeting-notes", currentDateDir(), "long-meeting", "transcript.jsonl"),
      "utf8",
    );
    expect(transcript).toContain("Action item: write the first draft.");
    expect(transcript).toContain("Decision: ship the final plan.");
  });

  it("keeps legacy flat-session artifacts together when stopping", async () => {
    const stateDir = await makeStateDir();
    const { tool } = await createHarness(stateDir);
    const sessionDir = path.join(stateDir, "meeting-notes", "legacy-standup");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "metadata.json"),
      `${JSON.stringify(
        {
          sessionId: "legacy-standup",
          title: "Legacy standup",
          source: { providerId: "manual-transcript" },
          startedAt: "2026-05-21T10:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(sessionDir, "transcript.jsonl"),
      `${JSON.stringify({
        sessionId: "legacy-standup",
        text: "Sam: Decision: keep old transcripts readable.",
      })}\n`,
    );
    await new MeetingNotesStore(path.join(stateDir, "meeting-notes")).appendUtterance(
      "legacy-standup",
      {
        text: "Alex: Action item: preserve appended legacy lines.",
      },
    );

    await tool.execute(
      "call-1",
      {
        action: "stop",
        sessionId: "legacy-standup",
      },
      undefined,
      vi.fn(),
    );

    await expect(fs.readFile(path.join(sessionDir, "summary.md"), "utf8")).resolves.toContain(
      "keep old transcripts readable",
    );
    await expect(fs.readFile(path.join(sessionDir, "summary.md"), "utf8")).resolves.toContain(
      "preserve appended legacy lines",
    );
    await expect(
      fs.access(
        path.join(stateDir, "meeting-notes", "2026-05-21", "legacy-standup", "metadata.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires date-qualified selectors for repeated stored session ids", async () => {
    const stateDir = await makeStateDir();
    const store = new MeetingNotesStore(path.join(stateDir, "meeting-notes"));
    await store.writeSession({
      sessionId: "standup",
      title: "Tuesday standup",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-21T10:00:00.000Z",
    });
    await store.writeSession({
      sessionId: "standup",
      title: "Wednesday standup",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
    });

    await expect(store.readSession("standup")).rejects.toThrow(
      "multiple meeting notes sessions match standup",
    );
    await expect(store.readSession("2026-05-21/standup")).resolves.toMatchObject({
      title: "Tuesday standup",
    });
  });

  it("keeps legacy flat selectors reachable after dated duplicates are added", async () => {
    const stateDir = await makeStateDir();
    const store = new MeetingNotesStore(path.join(stateDir, "meeting-notes"));
    const legacyDir = path.join(stateDir, "meeting-notes", "standup");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, "metadata.json"),
      `${JSON.stringify(
        {
          sessionId: "standup",
          title: "Legacy standup",
          source: { providerId: "manual-transcript" },
          startedAt: "2026-05-20T10:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    await store.writeSession({
      sessionId: "standup",
      title: "Dated standup",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
    });

    await expect(store.readSession("standup")).rejects.toThrow("legacy/standup");
    await expect(store.readSession("legacy/standup")).resolves.toMatchObject({
      title: "Legacy standup",
    });
  });

  it("summarizes an explicit legacy selector in the legacy directory", async () => {
    const stateDir = await makeStateDir();
    const { tool } = await createHarness(stateDir);
    const store = new MeetingNotesStore(path.join(stateDir, "meeting-notes"));
    const legacyDir = path.join(stateDir, "meeting-notes", "standup");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, "metadata.json"),
      `${JSON.stringify(
        {
          sessionId: "standup",
          title: "Legacy standup",
          source: { providerId: "manual-transcript" },
          startedAt: "2026-05-22T10:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(legacyDir, "transcript.jsonl"),
      `${JSON.stringify({
        sessionId: "standup",
        text: "Sam: Decision: summarize the flat legacy session.",
      })}\n`,
    );
    await store.writeSession({
      sessionId: "standup",
      title: "Dated standup",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
    });

    await tool.execute(
      "call-1",
      {
        action: "summarize",
        sessionId: "legacy/standup",
      },
      undefined,
      vi.fn(),
    );

    await expect(fs.readFile(path.join(legacyDir, "summary.md"), "utf8")).resolves.toContain(
      "summarize the flat legacy session",
    );
  });

  it("stops date-qualified active sessions with the canonical provider session id", async () => {
    const stateDir = await makeStateDir();
    const start = vi.fn(async (request) => {
      await request.onUtterance({
        text: "Sam: Decision: use date-qualified selectors for repeated names.",
      });
      return { ok: true, session: request.session };
    });
    const stop = vi.fn(async () => ({ ok: true }));
    getMeetingNotesSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);

    await tool.execute(
      "call-1",
      {
        action: "start",
        providerId: "discord-voice",
        sessionId: "standup",
        title: "Standup",
      },
      undefined,
      vi.fn(),
    );
    const result = await tool.execute(
      "call-2",
      {
        action: "stop",
        sessionId: `${currentDateDir()}/standup`,
      },
      undefined,
      vi.fn(),
    );

    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "standup",
      }),
    );
    expect(result).toMatchObject({
      details: {
        sessionId: "standup",
      },
    });
    await expect(
      fs.readFile(
        path.join(stateDir, "meeting-notes", currentDateDir(), "standup", "summary.md"),
        "utf8",
      ),
    ).resolves.toContain("date-qualified selectors");
  });

  it("does not stop a current active session when summarizing an older dated duplicate", async () => {
    const stateDir = await makeStateDir();
    const store = new MeetingNotesStore(path.join(stateDir, "meeting-notes"));
    const olderSession = {
      sessionId: "standup",
      title: "Older standup",
      source: { providerId: "discord-voice" },
      startedAt: "2026-05-21T10:00:00.000Z",
      stoppedAt: "2026-05-21T10:30:00.000Z",
    };
    await store.writeSession(olderSession);
    await store.appendUtteranceForSession(olderSession, {
      text: "Sam: Decision: preserve historical dated notes.",
    });
    const start = vi.fn(async (request) => ({ ok: true, session: request.session }));
    const stop = vi.fn(async () => ({ ok: true }));
    getMeetingNotesSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);

    await tool.execute(
      "call-1",
      {
        action: "start",
        providerId: "discord-voice",
        sessionId: "standup",
        title: "Current standup",
      },
      undefined,
      vi.fn(),
    );
    await tool.execute(
      "call-2",
      {
        action: "stop",
        sessionId: "2026-05-21/standup",
      },
      undefined,
      vi.fn(),
    );

    expect(stop).not.toHaveBeenCalled();
    await expect(
      fs.readFile(
        path.join(stateDir, "meeting-notes", "2026-05-21", "standup", "summary.md"),
        "utf8",
      ),
    ).resolves.toContain("preserve historical dated notes");

    await tool.execute(
      "call-3",
      {
        action: "stop",
        sessionId: "standup",
      },
      undefined,
      vi.fn(),
    );
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "standup",
      }),
    );
  });

  it("auto-starts configured live meeting sources", async () => {
    const stateDir = await makeStateDir();
    const start = vi.fn(async (request) => ({ ok: true, session: request.session }));
    getMeetingNotesSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
    });
    const { services } = await createHarness(stateDir, {
      autoStart: [
        {
          providerId: "discord-voice",
          sessionId: "standup",
          title: "Standup",
          guildId: "guild-1",
          channelId: "channel-1",
        },
      ],
    });
    expect(services).toHaveLength(1);

    await services[0]?.start({
      config: {},
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      stateDir,
    });
    for (let i = 0; i < 20 && start.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(getMeetingNotesSourceProviderMock).toHaveBeenCalledWith("discord-voice", {});
    expect(start).toHaveBeenCalledOnce();
    const request = start.mock.calls[0]?.[0];
    expect(request.session).toMatchObject({
      sessionId: "standup",
      title: "Standup",
      source: {
        providerId: "discord-voice",
        guildId: "guild-1",
        channelId: "channel-1",
      },
    });
    await expect(
      fs.readFile(
        path.join(stateDir, "meeting-notes", currentDateDir(), "standup", "metadata.json"),
        "utf8",
      ),
    ).resolves.toContain("Standup");
  });
});
