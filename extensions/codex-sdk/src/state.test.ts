import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileCodexNativeStateStore,
  extractCodexProposalsFromText,
  type CodexCompatibilityRecord,
} from "./state.js";
import { createTempDirTracker } from "./test-helpers.js";

const tempStateDirs = createTempDirTracker("openclaw-codex-sdk-state-test-");
const createTempStateDir = () => tempStateDirs.create();

afterEach(tempStateDirs.cleanup);

describe("FileCodexNativeStateStore", () => {
  it("stores sessions, events, proposals, and compatibility records", async () => {
    const stateDir = await createTempStateDir();
    const store = new FileCodexNativeStateStore({
      stateDir,
      options: {
        maxEventsPerSession: 10,
        proposalInboxLimit: 10,
      },
    });

    await store.upsertSession({
      sessionKey: "session-1",
      backend: "codex-sdk",
      agent: "codex",
      routeId: "default",
      routeLabel: "codex/default",
      model: "gpt-5.5",
      modelReasoningEffort: "xhigh",
      threadId: "thread-1",
      lifecycle: "started",
      status: "active",
    });

    const event = await store.recordEvent({
      sessionKey: "session-1",
      backend: "codex-sdk",
      routeId: "default",
      routeLabel: "codex/default",
      threadId: "thread-1",
      sdkEventType: "item.completed",
      mappedEvents: [
        {
          type: "text_delta",
          text: [
            "```openclaw-proposal",
            JSON.stringify({
              title: "Add native Codex inbox",
              summary: "Track proposed follow-up work.",
              actions: ["wire CLI", "show status"],
            }),
            "```",
          ].join("\n"),
        },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    expect(event.id).toBeTruthy();
    expect(await store.listEvents("session-1")).toHaveLength(1);
    expect(await store.getSession("session-1")).toEqual(
      expect.objectContaining({ sessionKey: "session-1" }),
    );
    expect(await store.listSessions()).toEqual([
      expect.objectContaining({
        sessionKey: "session-1",
        model: "gpt-5.5",
        modelReasoningEffort: "xhigh",
        turnCount: 1,
        threadId: "thread-1",
      }),
    ]);

    const proposals = await store.listProposals();
    expect(proposals).toEqual([
      expect.objectContaining({
        title: "Add native Codex inbox",
        status: "new",
        actions: ["wire CLI", "show status"],
      }),
    ]);
    expect(await store.getProposal(proposals[0]!.id)).toEqual(proposals[0]);

    const created = await store.createProposal({
      title: "Backchannel proposal",
      summary: "Created without a streamed text fence.",
      actions: ["inspect"],
    });
    expect(created).toMatchObject({
      title: "Backchannel proposal",
      status: "new",
      sessionKey: "codex:backchannel",
    });
    expect(await store.listProposals()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })]),
    );

    const updated = await store.updateProposalStatus(proposals[0]!.id, "accepted");
    expect(updated).toMatchObject({ status: "accepted" });
    const executed = await store.updateProposal(proposals[0]!.id, {
      executedAt: "2026-04-30T00:00:00.000Z",
      executedSessionKey: "codex:proposal:test",
      executedThreadId: "thread-exec",
      executionRouteId: "ship",
    });
    expect(executed).toMatchObject({
      status: "accepted",
      executedSessionKey: "codex:proposal:test",
      executedThreadId: "thread-exec",
      executionRouteId: "ship",
    });

    const compatibility: CodexCompatibilityRecord = {
      schemaVersion: 2,
      id: "compat-1",
      checkedAt: new Date().toISOString(),
      ok: true,
      backend: "codex-sdk",
      sdkPackage: "@openai/codex-sdk",
      sdkVersion: "0.128.0",
      defaultRoute: "default",
      checks: [{ id: "sdk_import", status: "pass", message: "ok" }],
    };
    await store.writeCompatibilityRecord(compatibility);
    expect(await store.listCompatibilityRecords()).toEqual([compatibility]);
  });

  it("caps retained events on disk per session", async () => {
    const stateDir = await createTempStateDir();
    const store = new FileCodexNativeStateStore({
      stateDir,
      options: {
        maxEventsPerSession: 2,
        proposalInboxLimit: 10,
      },
    });

    await store.upsertSession({
      sessionKey: "session-1",
      backend: "codex-sdk",
      agent: "codex",
      routeId: "default",
      routeLabel: "codex/default",
      lifecycle: "started",
      status: "active",
    });

    for (const type of ["event-1", "event-2", "event-3"]) {
      await store.recordEvent({
        sessionKey: "session-1",
        backend: "codex-sdk",
        routeId: "default",
        routeLabel: "codex/default",
        sdkEventType: type,
        mappedEvents: [{ type: "status", text: type }],
      });
    }

    expect((await store.listEvents("session-1", 10)).map((event) => event.sdkEventType)).toEqual([
      "event-2",
      "event-3",
    ]);

    const eventFile = path.join(stateDir, "codex-sdk", "events", "session-1.jsonl");
    const eventLines = (await fs.readFile(eventFile, "utf8")).trim().split("\n");
    expect(eventLines).toHaveLength(2);
  });

  it("extracts parseable and unparseable proposal fences", () => {
    expect(
      extractCodexProposalsFromText(
        [
          "```openclaw-proposal",
          '{"title":"Review Codex route docs","body":"Add examples."}',
          "```",
          "```openclaw-proposal",
          "{not-json",
          "```",
        ].join("\n"),
      ),
    ).toEqual([
      {
        title: "Review Codex route docs",
        body: "Add examples.",
      },
      {
        title: "Unparsed Codex proposal",
        body: "{not-json",
      },
    ]);
  });
});
