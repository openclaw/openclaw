import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { injectFileShortReads } from "../../test-support/file-short-reads.test-support.js";
import { piJsonl, piMessage, usePiFixtures } from "./pi-session-catalog.test-support.js";
import { checkPiUpstreamActivity, linkContinuedPiSession } from "./pi-session-upstream-activity.js";

const { createStore } = usePiFixtures();

const userRow = (content: string, timestamp: string) =>
  piMessage({ role: "user", content }, { timestamp });
const appendUser = (file: string, ...row: Parameters<typeof userRow>) =>
  fs.appendFile(file, piJsonl([userRow(...row)]));
const activity = (fields: Record<string, unknown>) => [
  expect.objectContaining({ kind: "activity", ...fields }),
];

async function createActivityFixture(ownRecentUserTexts: string[] = []) {
  const sessionDirectory = await createStore("hi", "Pi catalog session", { command: "pwd" }, true);
  const continued = await linkContinuedPiSession("agent:main:pi", "pi-session");
  const probe = {
    sessionKey: continued.sessionKey,
    agentId: "main",
    threadId: "pi-session",
    hostId: "gateway",
    upstreamKind: continued.upstream!.kind,
    upstreamRef: continued.upstream!.ref,
    marker: continued.upstream!.marker,
    ownRecentUserTexts,
  };
  return {
    file: path.join(sessionDirectory, "session.jsonl"),
    probe,
    check: (marker = probe.marker) => checkPiUpstreamActivity([{ ...probe, marker }]),
  };
}

describe("Pi session upstream activity", () => {
  it("detects external turns, suppresses own echoes, and confirms deletion", async () => {
    const { file, probe, check } = await createActivityFixture(["sent from OpenClaw"]);

    await appendUser(file, "sent  from OpenClaw", "2026-07-13T10:00:05.000Z");
    const ownEcho = await check();
    expect(ownEcho).toEqual(activity({ sessionKey: probe.sessionKey, humanTurns: 0 }));

    await appendUser(file, "external Pi turn", "2026-07-13T10:00:06.000Z");
    const external = await check(ownEcho[0]!.kind === "activity" ? ownEcho[0]!.nextMarker : null);
    expect(external).toEqual(activity({ sessionKey: probe.sessionKey, humanTurns: 1 }));

    await fs.rm(file);
    await expect(check()).resolves.toEqual([{ kind: "missing", sessionKey: probe.sessionKey }]);
  });

  it("does not classify transient read failures as missing", async () => {
    const { probe } = await createActivityFixture();
    await expect(
      checkPiUpstreamActivity([
        {
          ...probe,
          upstreamRef: { filePath: `/${"x".repeat(10_000)}` },
          marker: { offset: 0 },
        },
      ]),
    ).resolves.toEqual([]);
  });

  it("completes bounded scan windows across positional short reads", async () => {
    const { file, check } = await createActivityFixture();
    await appendUser(file, "short-read Pi turn", "2026-07-13T10:00:05.000Z");
    await injectFileShortReads(file, 17);
    const completeSize = (await fs.stat(file)).size;

    await expect(check()).resolves.toEqual(
      activity({ humanTurns: 1, nextMarker: { offset: completeSize } }),
    );

    await fs.appendFile(file, '{"type":"message"');
    await expect(check({ offset: completeSize })).resolves.toEqual([]);
  });

  it("preserves Pi date parsing for numeric-looking activity timestamps", async () => {
    const { file, check } = await createActivityFixture();

    await appendUser(file, "first external Pi turn", "0");
    const first = await check();
    expect(first).toEqual(activity({ humanTurns: 1, occurredAt: Date.parse("0") }));
  });

  it("stops the cursor before the first unclassifiable complete row", async () => {
    const { file, check } = await createActivityFixture();
    await fs.appendFile(
      file,
      piJsonl([userRow("first external turn", "2026-07-13T10:00:05.000Z")]) +
        "{not-json}\n" +
        piJsonl([userRow("must remain behind the bad row", "2026-07-13T10:00:06.000Z")]),
    );

    const first = await check();
    expect(first).toEqual(activity({ humanTurns: 1 }));
    await expect(
      check(first[0]!.kind === "activity" ? first[0]!.nextMarker : null),
    ).resolves.toEqual([]);
  });
});
