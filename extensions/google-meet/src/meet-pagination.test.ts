import { afterEach, expect, it, vi } from "vitest";
import { fetchGoogleMeetArtifacts } from "./meet.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: async (params: { url: string; init?: RequestInit }) => ({
    response: await fetch(params.url, params.init),
    release: async () => {},
  }),
}));

afterEach(() => vi.restoreAllMocks());

it.each([
  { name: "complete", tokens: ["page-2", undefined], fails: false },
  { name: "repeated", tokens: ["page-2", "page-2"], fails: true },
  { name: "cyclic", tokens: ["page-2", "page-3", "page-2"], fails: true },
])("terminates artifact pagination with $name page tokens", async ({ tokens, fails }) => {
  const requestedTokens: (string | null)[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === "/v2/conferenceRecords/rec-1") {
      return Response.json({ name: "conferenceRecords/rec-1" });
    }
    if (url.pathname.endsWith("/participants")) {
      requestedTokens.push(url.searchParams.get("pageToken"));
      if (requestedTokens.length > tokens.length) {
        throw new Error("test iteration cap: pagination kept requesting pages");
      }
      return Response.json({
        participants: [{ name: `conferenceRecords/rec-1/participants/p${requestedTokens.length}` }],
        nextPageToken: tokens[requestedTokens.length - 1],
      });
    }
    if (/\/(recordings|transcripts|smartNotes)$/.test(url.pathname)) {
      return Response.json({});
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  });

  const request = fetchGoogleMeetArtifacts({
    accessToken: "test-token",
    conferenceRecord: "rec-1",
  });
  if (fails) {
    await expect(request).rejects.toThrow(
      "Google Meet conferenceRecords.participants.list repeated nextPageToken",
    );
  } else {
    const result = await request;
    expect(result.artifacts[0]?.participants.map((participant) => participant.name)).toEqual([
      "conferenceRecords/rec-1/participants/p1",
      "conferenceRecords/rec-1/participants/p2",
    ]);
  }
  expect(requestedTokens).toEqual([null, ...tokens.slice(0, -1)]);
});
