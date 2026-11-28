import { describe, expect, it } from "vitest";
import { resolveGoogleVertexConfigApiKey } from "./vertex-adc-config.js";

describe("resolveGoogleVertexConfigApiKey", () => {
  it("returns undefined when project or location env is missing", () => {
    expect(resolveGoogleVertexConfigApiKey({ GCE_METADATA_HOST: "metadata.google.internal" })).toBeUndefined();
    expect(
      resolveGoogleVertexConfigApiKey({
        GOOGLE_CLOUD_PROJECT: "my-project",
        GCE_METADATA_HOST: "metadata.google.internal",
      }),
    ).toBeUndefined();
  });

  it("returns marker when project, location, and GCE metadata env are present", () => {
    expect(
      resolveGoogleVertexConfigApiKey({
        GOOGLE_CLOUD_PROJECT: "my-project",
        GOOGLE_CLOUD_LOCATION: "global",
        GCE_METADATA_HOST: "metadata.google.internal",
      }),
    ).toBe("gcp-vertex-credentials");
  });

  it("returns undefined when GOOGLE_APPLICATION_CREDENTIALS points to a missing file", () => {
    expect(
      resolveGoogleVertexConfigApiKey({
        GOOGLE_CLOUD_PROJECT: "my-project",
        GOOGLE_CLOUD_LOCATION: "global",
        GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/adc.json",
        GCE_METADATA_HOST: "metadata.google.internal",
      }),
    ).toBeUndefined();
  });
});
