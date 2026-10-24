// Msteams tests cover errors plugin behavior.
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  classifyMSTeamsSendError,
  formatMSTeamsDeliveryFailureGuidance,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";

function replaySafeRetryAfterMs(error: unknown): number | undefined {
  const classification = classifyMSTeamsSendError(error);
  return classification.kind === "replay-safe" ? classification.retryAfterMs : undefined;
}

describe("msteams errors", () => {
  it.each([
    [403, "auth"],
    [429, "replay-safe"],
    [504, "ambiguous"],
  ] as const)("classifies real Connector HTTP %i errors as %s", async (status, kind) => {
    const { Client: ApiClient } = await import("@microsoft/teams.api");
    let requests = 0;
    await withServer(
      (request, response) => {
        requests += 1;
        request.resume();
        response.writeHead(status, {
          "content-type": "application/json",
          "retry-after": "2",
        });
        response.end(JSON.stringify({ error: { code: "ConnectorFailure", message: "rejected" } }));
      },
      async (baseUrl) => {
        const api = new ApiClient(baseUrl);
        const result = await api.conversations
          .activities("loopback-conversation")
          .create({ type: "message", text: "synthetic reply" })
          .then(
            () => undefined,
            (error: unknown) => classifyMSTeamsSendError(error),
          );
        expect(result).toMatchObject({ kind, statusCode: status });
        if (result?.kind === "replay-safe") {
          expect(result.retryAfterMs).toBe(2000);
        }
        expect(requests).toBe(1);
      },
    );
  });

  it("formats unknown errors", () => {
    expect(formatUnknownError("oops")).toBe("oops");
    expect(formatUnknownError(null)).toBe("null");
  });

  it("classifies auth errors", () => {
    expect(classifyMSTeamsSendError({ statusCode: 401 }).kind).toBe("auth");
    expect(classifyMSTeamsSendError({ statusCode: 403 }).kind).toBe("auth");
  });

  it("retains the normalized retry delay on replay-safe rate limits", () => {
    const result = classifyMSTeamsSendError({ statusCode: 429, retryAfterMs: 1500 });
    expect(result.kind).toBe("replay-safe");
    expect(result.statusCode).toBe(429);
    expect(replaySafeRetryAfterMs({ statusCode: 429, retryAfterMs: 1500 })).toBe(1500);
  });

  it("does not parse partial retry-after values", () => {
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        response: { headers: { "retry-after": "2 seconds" } },
      }),
    ).toBeUndefined();
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        response: { headers: new Headers({ "retry-after": "3 seconds" }) },
      }),
    ).toBeUndefined();
  });

  it("ignores unsafe retry-after magnitudes", () => {
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        retryAfterMs: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBeUndefined();
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        response: { headers: { "retry-after": "9007199254741" } },
      }),
    ).toBeUndefined();
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        response: { headers: new Headers({ "retry-after": "9007199254741" }) },
      }),
    ).toBeUndefined();
  });

  it("does not parse partial or fractional status codes", () => {
    expect(classifyMSTeamsSendError({ statusCode: "429oops" }).kind).toBe("unknown");
    expect(classifyMSTeamsSendError({ statusCode: 429.5 }).kind).toBe("unknown");
    expect(
      classifyMSTeamsSendError({ response: { status: "503 temporarily unavailable" } }).kind,
    ).toBe("unknown");
  });

  it.each([408, 504])("classifies HTTP %i as delivery-ambiguous", (statusCode) => {
    const classification = classifyMSTeamsSendError({ statusCode });
    expect(classification).toMatchObject({
      kind: "ambiguous",
      source: "http",
      statusCode,
    });
    expect(formatMSTeamsSendErrorHint(classification)).toContain("outcome is unknown");
    expect(formatMSTeamsSendErrorHint(classification)).not.toMatch(/retry|resend/iu);
    expect(formatMSTeamsDeliveryFailureGuidance(classification)).toContain(
      "may already have succeeded",
    );
    expect(formatMSTeamsDeliveryFailureGuidance(classification)).not.toContain(
      "Retrying later may succeed",
    );
  });

  it("keeps model guidance aligned with replay safety", () => {
    expect(
      formatMSTeamsDeliveryFailureGuidance(classifyMSTeamsSendError({ statusCode: 429 })),
    ).toBe("The request was rate-limited before delivery; retrying later may succeed.");
    expect(
      formatMSTeamsDeliveryFailureGuidance(classifyMSTeamsSendError({ statusCode: 401 })),
    ).toBeUndefined();
  });

  it("classifies permanent 4xx errors", () => {
    const result = classifyMSTeamsSendError({ statusCode: 400 });
    expect(result.kind).toBe("permanent");
    expect(result.statusCode).toBe(400);
  });

  it("provides actionable hints for common cases", () => {
    expect(formatMSTeamsSendErrorHint(classifyMSTeamsSendError({ statusCode: 401 }))).toContain(
      "msteams",
    );
    expect(formatMSTeamsSendErrorHint(classifyMSTeamsSendError({ statusCode: 429 }))).toContain(
      "throttled",
    );
    expect(
      formatMSTeamsSendErrorHint(
        classifyMSTeamsSendError({
          statusCode: 403,
          code: "ContentStreamNotAllowed",
        }),
      ),
    ).toContain("expired the content stream");
  });

  it.each(["ETIMEDOUT"])("keeps transport %s delivery ambiguous without retry guidance", (code) => {
    const classification = classifyMSTeamsSendError(Object.assign(new Error(code), { code }));
    expect(classification).toMatchObject({
      kind: "ambiguous",
      source: "transport",
      errorCode: code,
    });
    expect(formatMSTeamsSendErrorHint(classification)).toContain("smba");
    expect(formatMSTeamsSendErrorHint(classification)).toContain("egress");
    expect(formatMSTeamsSendErrorHint(classification)).toContain("outcome is unknown");
    expect(formatMSTeamsSendErrorHint(classification)).not.toMatch(/retry|resend/iu);
  });

  it("still classifies HTTP errors as unknown when no status code and no network code", () => {
    expect(classifyMSTeamsSendError(new Error("unexpected error")).kind).toBe("unknown");
    expect(classifyMSTeamsSendError(null).kind).toBe("unknown");
  });
});
