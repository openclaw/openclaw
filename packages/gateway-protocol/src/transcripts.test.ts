import { Check } from "typebox/schema";
import { describe, expect, it } from "vitest";
import {
  transcriptGetFixture,
  transcriptListFixture,
  transcriptStatusFixture,
} from "../../../src/transcripts/library.test-support.js";
import {
  TranscriptsGetResultSchema,
  TranscriptsListResultSchema,
  TranscriptsStatusResultSchema,
} from "./schema/transcripts.js";
import {
  validateTranscriptsExportParams,
  validateTranscriptsGetParams,
  validateTranscriptsListParams,
  validateTranscriptsStatusParams,
} from "./validator-registry.js";

const validateStatus = (value: unknown) => Check(TranscriptsStatusResultSchema, value);
const sourceRow = { source: { providerId: "fixture" }, state: "not-active", activeSelectors: [] };
const withSources = (configuredSources: unknown[]) => ({
  ...transcriptStatusFixture,
  configuredSources,
});

describe("transcript UI wire contracts", () => {
  it("accepts closed startup diagnostics without raw errors or unbounded extra rows", () => {
    const response = (startDiagnostic: unknown) => withSources([{ ...sourceRow, startDiagnostic }]);
    for (const code of [
      "starting",
      "retrying",
      "id-conflict",
      "admitted-start-failed",
      "start-failed",
      "ended",
    ]) {
      expect(validateStatus(response(code))).toBe(true);
    }
    const failed = { ...sourceRow, startDiagnostic: "start-failed" };
    const tooMany = Array.from({ length: 101 }, () => ({
      ...sourceRow,
      startDiagnostic: "starting",
    }));
    for (const invalid of [
      response("raw provider error"),
      withSources([{ ...failed, error: "private" }]),
      withSources(tooMany),
    ]) {
      expect(validateStatus(invalid)).toBe(false);
    }
  });
  it("validates shared UI fixture responses against the canonical wire schemas", () => {
    expect(Check(TranscriptsListResultSchema, transcriptListFixture)).toBe(true);
    expect(Check(TranscriptsGetResultSchema, transcriptGetFixture)).toBe(true);
    expect(validateStatus(transcriptStatusFixture)).toBe(true);
    const validateGet = (value: unknown) => Check(TranscriptsGetResultSchema, value);
    const utterances = Array.from({ length: 2000 }, (_, sequence) => ({
      sequence,
      text: "speech",
    }));
    const response = (rows: typeof utterances) => ({ ...transcriptGetFixture, utterances: rows });
    expect(validateGet(response(utterances))).toBe(true);
    expect(validateGet(response([...utterances, { sequence: 2000, text: "outside" }]))).toBe(false);
  });

  it("keeps pagination and search bounded and rejects mutation arguments", () => {
    expect(validateTranscriptsListParams({})).toBe(true);
    const filter = { limit: 100, query: "x".repeat(256), startedAfter: "2026-08-20T00:00:00Z" };
    expect(validateTranscriptsListParams(filter)).toBe(true);
    expect(validateTranscriptsListParams({ limit: 200 })).toBe(true);
    for (const limit of [0, 201, -1, 1.5, "50"]) {
      expect(validateTranscriptsListParams({ limit })).toBe(false);
    }
    expect(validateTranscriptsListParams({ query: "x".repeat(257) })).toBe(false);
    expect(validateTranscriptsGetParams({ selector: "opaque/full-value", limit: 100 })).toBe(true);
    const oversized = { selector: "opaque", includeUtterances: true, limit: 101 };
    expect(validateTranscriptsGetParams(oversized)).toBe(false);
    expect(validateTranscriptsGetParams({ selector: "opaque", agentId: "forged" })).toBe(false);
    expect(validateTranscriptsExportParams({ selector: "opaque", format: "jsonl" })).toBe(true);
    expect(validateTranscriptsExportParams({ selector: "opaque", format: "markdown" })).toBe(true);
    expect(validateTranscriptsExportParams({ selector: "opaque", format: "audio" })).toBe(false);
    expect(validateTranscriptsStatusParams({})).toBe(true);
    expect(validateTranscriptsStatusParams({ enabled: true, autoStart: [] })).toBe(false);
  });

  it("keeps auto-start descriptors optional, closed, and limited to existing locator fields", () => {
    const response = (autoStart: unknown) => ({
      ...transcriptStatusFixture,
      providers: [{ ...transcriptStatusFixture.providers[0], autoStart }],
    });
    const validDescriptor = {
      accountId: "optional",
      guildId: "required",
      channelId: "required",
      meetingUrl: "optional",
    };
    expect(validateStatus(response(validDescriptor))).toBe(true);
    expect(validateStatus(response({}))).toBe(true);
    for (const descriptor of [
      { fileId: "required" },
      { sessionId: "optional" },
      { accountId: true },
      { channelId: "unknown" },
    ]) {
      expect(validateStatus(response(descriptor))).toBe(false);
    }
  });
});
