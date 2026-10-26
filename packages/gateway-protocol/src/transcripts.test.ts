import { describe, it } from "vitest";
import {
  transcriptGetFixture,
  transcriptListFixture,
  transcriptStatusFixture,
} from "../../../src/transcripts/library.test-support.js";
import * as p from "./index.js";
import { copies, schemaValidation, validation } from "./schema/protocol-validation.test-support.js";

const status = schemaValidation(p.TranscriptsStatusResultSchema);
const get = schemaValidation(p.TranscriptsGetResultSchema);
const listParams = validation(p.validateTranscriptsListParams);
const getParams = validation(p.validateTranscriptsGetParams);
const exportParams = validation(p.validateTranscriptsExportParams);
const sourceRow = { source: { providerId: "fixture" }, state: "not-active", activeSelectors: [] };
const withSources = (configuredSources: unknown[]) => ({
  ...transcriptStatusFixture,
  configuredSources,
});

describe("transcript UI wire contracts", () => {
  it("accepts closed startup diagnostics without raw errors or unbounded extra rows", () => {
    const response = (startDiagnostic: unknown) => withSources([{ ...sourceRow, startDiagnostic }]);
    status.accepts(
      ...[
        "starting",
        "retrying",
        "id-conflict",
        "admitted-start-failed",
        "start-failed",
        "ended",
      ].map(response),
    );
    const failed = { ...sourceRow, startDiagnostic: "start-failed" };
    status.rejects(
      response("raw provider error"),
      withSources([{ ...failed, error: "private" }]),
      withSources(Array.from({ length: 101 }, () => failed)),
    );
  });
  it("validates shared UI fixture responses against the canonical wire schemas", () => {
    schemaValidation(p.TranscriptsListResultSchema).accepts(transcriptListFixture);
    status.accepts(transcriptStatusFixture);
    const utterances = copies({ sequence: 0, text: "speech" }, 2000);
    const response = (rows: typeof utterances) => ({ ...transcriptGetFixture, utterances: rows });
    get.accepts(transcriptGetFixture, response(utterances));
    get.rejects(response([...utterances, { sequence: 2000, text: "outside" }]));
  });

  it("keeps pagination and search bounded and rejects mutation arguments", () => {
    listParams.accepts({
      limit: 100,
      query: "x".repeat(256),
      startedAfter: "2026-08-20T00:00:00Z",
    });
    listParams.rejects(...[0, 201, 1.5, "50"].map((limit) => ({ limit })), {
      query: "x".repeat(257),
    });
    getParams.accepts({ selector: "opaque/full-value", limit: 100 });
    getParams.rejects(
      { selector: "opaque", includeUtterances: true, limit: 101 },
      { selector: "opaque", agentId: "forged" },
    );
    exportParams.accepts(
      ...["jsonl", "markdown"].map((format) => ({ selector: "opaque", format })),
    );
    exportParams.rejects({ selector: "opaque", format: "audio" });
    validation(p.validateTranscriptsStatusParams).accepts({});
    validation(p.validateTranscriptsStatusParams).rejects({ enabled: true, autoStart: [] });
  });

  it("keeps auto-start descriptors optional, closed, and limited to existing locator fields", () => {
    const response = (autoStart: unknown) => ({
      ...transcriptStatusFixture,
      providers: [{ ...transcriptStatusFixture.providers[0], autoStart }],
    });
    status.accepts(
      response({
        accountId: "optional",
        guildId: "required",
        channelId: "required",
        meetingUrl: "optional",
      }),
      response({}),
    );
    status.rejects(
      ...[
        { fileId: "required" },
        { sessionId: "optional" },
        { accountId: true },
        { channelId: "unknown" },
      ].map(response),
    );
  });
});
