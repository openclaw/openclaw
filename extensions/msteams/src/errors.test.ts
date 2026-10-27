import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import {
  classifyMSTeamsSendError as classify,
  formatMSTeamsDeliveryFailureGuidance as guidance,
  formatMSTeamsSendErrorHint as hint,
  formatUnknownError,
} from "./errors.js";

it.each([
  [403, "auth"],
  [429, "replay-safe"],
  [504, "ambiguous"],
] as const)("classifies real Connector HTTP %i errors as %s", async (status, kind) => {
  const { Client: ApiClient } = await import("@microsoft/teams.api");
  await withServer(
    (request, response) => {
      request.resume();
      response.writeHead(status, { "content-type": "application/json", "retry-after": "2" });
      response.end(JSON.stringify({ error: { code: "ConnectorFailure", message: "rejected" } }));
    },
    async (baseUrl) => {
      const result = await new ApiClient(baseUrl).conversations
        .activities("loopback-conversation")
        .create({ type: "message", text: "synthetic reply" })
        .then(
          () => undefined,
          (error: unknown) => classify(error),
        );
      expect(result).toMatchObject({ kind, statusCode: status });
      if (result?.kind === "replay-safe") {
        expect(result.retryAfterMs).toBe(2000);
      }
    },
  );
});

it("formats unknown errors", () => {
  expect(formatUnknownError("oops")).toBe("oops");
  expect(formatUnknownError(null)).toBe("null");
});

it.each([
  [{ statusCode: 401 }, { kind: "auth" }],
  [{ statusCode: 400 }, { kind: "permanent", statusCode: 400 }],
  [
    { statusCode: 429, retryAfterMs: 1500 },
    { kind: "replay-safe", statusCode: 429, retryAfterMs: 1500 },
  ],
  [{ statusCode: "429oops" }, { kind: "unknown" }],
  [{ statusCode: 429.5 }, { kind: "unknown" }],
  [{ response: { status: "503 temporarily unavailable" } }, { kind: "unknown" }],
  [new Error("unexpected error"), { kind: "unknown" }],
  [null, { kind: "unknown" }],
] as const)("classifies %j", (error, expected) => expect(classify(error)).toMatchObject(expected));

it.each([
  { response: { headers: { "retry-after": "2 seconds" } } },
  { response: { headers: new Headers({ "retry-after": "3 seconds" }) } },
  { retryAfterMs: Number.MAX_SAFE_INTEGER + 1 },
  { response: { headers: { "retry-after": "9007199254741" } } },
  { response: { headers: new Headers({ "retry-after": "9007199254741" }) } },
])("rejects partial or unsafe retry delays: %j", (fields) => {
  const result = classify({ statusCode: 429, ...fields });
  expect(result).toMatchObject({ kind: "replay-safe", retryAfterMs: undefined });
});

it.each([408, 504])("keeps HTTP %i ambiguous without retry guidance", (statusCode) => {
  const result = classify({ statusCode });
  expect(result).toMatchObject({ kind: "ambiguous", source: "http", statusCode });
  expect(hint(result)).toContain("outcome is unknown");
  expect(hint(result)).not.toMatch(/retry|resend/iu);
  expect(guidance(result)).toContain("may already have succeeded");
  expect(guidance(result)).not.toContain("Retrying later may succeed");
});

it("keeps model guidance aligned with replay safety", () => {
  expect(guidance(classify({ statusCode: 429 }))).toBe(
    "The request was rate-limited before delivery; retrying later may succeed.",
  );
  expect(guidance(classify({ statusCode: 401 }))).toBeUndefined();
});

it.each([
  [{ statusCode: 401 }, "msteams"],
  [{ statusCode: 429 }, "throttled"],
  [{ statusCode: 403, code: "ContentStreamNotAllowed" }, "expired the content stream"],
] as const)("provides actionable hints for %j", (error, expected) => {
  expect(hint(classify(error))).toContain(expected);
});

it("keeps transport ETIMEDOUT ambiguous without retry guidance", () => {
  const result = classify(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }));
  expect(result).toMatchObject({ kind: "ambiguous", source: "transport", errorCode: "ETIMEDOUT" });
  expect(hint(result)).toContain("smba");
  expect(hint(result)).toContain("egress");
  expect(hint(result)).toContain("outcome is unknown");
  expect(hint(result)).not.toMatch(/retry|resend/iu);
});
