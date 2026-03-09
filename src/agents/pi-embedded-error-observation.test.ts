import { describe, expect, it } from "vitest";
import { buildApiErrorObservationFields } from "./pi-embedded-error-observation.js";

describe("buildApiErrorObservationFields", () => {
  it("redacts request ids and exposes stable hashes instead of raw payloads", () => {
    const observed = buildApiErrorObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_overload"}',
    );

    expect(observed).toMatchObject({
      rawErrorPreview: expect.stringContaining('"request_id":"sha256:'),
      rawErrorHash: expect.stringMatching(/^sha256:/),
      rawErrorFingerprint: expect.stringMatching(/^sha256:/),
      providerErrorType: "overloaded_error",
      providerErrorMessagePreview: "Overloaded",
      requestIdHash: expect.stringMatching(/^sha256:/),
    });
    expect(observed.rawErrorPreview).not.toContain("req_overload");
  });
});
