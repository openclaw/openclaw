import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiStoreFixture } from "./pi-session-catalog.test-support.js";
import { checkPiUpstreamActivity, linkContinuedPiSession } from "./pi-session-upstream-activity.js";

const temporaryDirectories: string[] = [];
const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalSessionDir === undefined) {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
  }
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

function injectFileShortReads(filePath: string, maxBytes: number): void {
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (args[0] === filePath) {
      const realRead = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        configurable: true,
        value: (buffer: Buffer, offset: number, length: number, position: number) =>
          realRead(buffer, offset, Math.min(length, maxBytes), position),
      });
    }
    return handle;
  });
}

describe("Pi session upstream activity", () => {
  it("detects external turns, suppresses own echoes, and confirms deletion", async () => {
    const sessionDirectory = await createPiStoreFixture(
      temporaryDirectories,
      "hi",
      "Pi catalog session",
      { command: "pwd" },
      true,
    );
    const continued = await linkContinuedPiSession("agent:main:pi", "pi-session");
    const file = path.join(sessionDirectory, "session.jsonl");
    const probe = {
      sessionKey: continued.sessionKey,
      agentId: "main",
      threadId: "pi-session",
      hostId: "gateway",
      upstreamKind: continued.upstream!.kind,
      upstreamRef: continued.upstream!.ref,
      marker: continued.upstream!.marker,
      ownRecentUserTexts: ["sent from OpenClaw"],
    };

    await fs.appendFile(
      file,
      `${JSON.stringify({
        type: "message",
        id: "user-own",
        parentId: "info-1",
        timestamp: "2026-07-13T10:00:05.000Z",
        message: { role: "user", content: "sent  from OpenClaw" },
      })}\n`,
    );
    const ownEcho = await checkPiUpstreamActivity([probe]);
    expect(ownEcho).toEqual([
      expect.objectContaining({
        kind: "activity",
        sessionKey: continued.sessionKey,
        humanTurns: 0,
      }),
    ]);

    await fs.appendFile(
      file,
      `${JSON.stringify({
        type: "message",
        id: "user-external",
        parentId: "user-own",
        timestamp: "2026-07-13T10:00:06.000Z",
        message: { role: "user", content: "external Pi turn" },
      })}\n`,
    );
    const external = await checkPiUpstreamActivity([
      { ...probe, marker: ownEcho[0]!.kind === "activity" ? ownEcho[0]!.nextMarker : null },
    ]);
    expect(external).toEqual([
      expect.objectContaining({
        kind: "activity",
        sessionKey: continued.sessionKey,
        humanTurns: 1,
      }),
    ]);

    await fs.rm(file);
    await expect(checkPiUpstreamActivity([probe])).resolves.toEqual([
      { kind: "missing", sessionKey: continued.sessionKey },
    ]);
  });

  it("does not classify transient read failures as missing", async () => {
    await expect(
      checkPiUpstreamActivity([
        {
          sessionKey: "agent:main:pi",
          agentId: "main",
          threadId: "pi-session",
          hostId: "gateway",
          upstreamKind: "pi-cli",
          upstreamRef: { filePath: `/${"x".repeat(10_000)}` },
          marker: { offset: 0 },
          ownRecentUserTexts: [],
        },
      ]),
    ).resolves.toEqual([]);
  });

  it("completes bounded scan windows across positional short reads", async () => {
    const sessionDirectory = await createPiStoreFixture(
      temporaryDirectories,
      "hi",
      "Pi catalog session",
      { command: "pwd" },
      true,
    );
    const continued = await linkContinuedPiSession("agent:main:pi", "pi-session");
    const file = path.join(sessionDirectory, "session.jsonl");
    const marker = continued.upstream!.marker;
    await fs.appendFile(
      file,
      `${JSON.stringify({
        type: "message",
        timestamp: "2026-07-13T10:00:05.000Z",
        message: { role: "user", content: "short-read Pi turn" },
      })}\n`,
    );
    injectFileShortReads(file, 17);

    await expect(
      checkPiUpstreamActivity([
        {
          sessionKey: continued.sessionKey,
          agentId: "main",
          threadId: "pi-session",
          hostId: "gateway",
          upstreamKind: continued.upstream!.kind,
          upstreamRef: continued.upstream!.ref,
          marker,
          ownRecentUserTexts: [],
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "activity",
        humanTurns: 1,
        nextMarker: { offset: (await fs.stat(file)).size },
      }),
    ]);
  });

  it("stops the cursor before the first unclassifiable complete row", async () => {
    const sessionDirectory = await createPiStoreFixture(
      temporaryDirectories,
      "hi",
      "Pi catalog session",
      { command: "pwd" },
      true,
    );
    const continued = await linkContinuedPiSession("agent:main:pi", "pi-session");
    const file = path.join(sessionDirectory, "session.jsonl");
    const probe = {
      sessionKey: continued.sessionKey,
      agentId: "main",
      threadId: "pi-session",
      hostId: "gateway",
      upstreamKind: continued.upstream!.kind,
      upstreamRef: continued.upstream!.ref,
      marker: continued.upstream!.marker,
      ownRecentUserTexts: [],
    };
    await fs.appendFile(
      file,
      `${JSON.stringify({
        type: "message",
        timestamp: "2026-07-13T10:00:05.000Z",
        message: { role: "user", content: "first external turn" },
      })}\n{not-json}\n${JSON.stringify({
        type: "message",
        timestamp: "2026-07-13T10:00:06.000Z",
        message: { role: "user", content: "must remain behind the bad row" },
      })}\n`,
    );

    const first = await checkPiUpstreamActivity([probe]);
    expect(first).toEqual([expect.objectContaining({ kind: "activity", humanTurns: 1 })]);
    await expect(
      checkPiUpstreamActivity([
        { ...probe, marker: first[0]!.kind === "activity" ? first[0]!.nextMarker : null },
      ]),
    ).resolves.toEqual([]);
  });
});
