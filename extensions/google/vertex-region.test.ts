import { describe, expect, it } from "vitest";
import {
  resolveGoogleVertexBaseUrl,
  resolveGoogleVertexClientRegion,
  resolveGoogleVertexConfigApiKey,
  resolveGoogleVertexRegion,
  resolveGoogleVertexRegionFromBaseUrl,
} from "./vertex-region.js";

describe("google vertex region helpers", () => {
  it("accepts well-formed region env values", () => {
    expect(
      resolveGoogleVertexRegion({ GOOGLE_CLOUD_LOCATION: "us-east1" } as NodeJS.ProcessEnv),
    ).toBe("us-east1");
  });

  it("returns undefined when no env region is configured", () => {
    expect(resolveGoogleVertexRegion({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("rejects malformed region env values", () => {
    expect(
      resolveGoogleVertexRegion({
        GOOGLE_CLOUD_LOCATION: "us-central1.attacker.example",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it("falls back to CLOUD_ML_REGION", () => {
    expect(
      resolveGoogleVertexRegion({ CLOUD_ML_REGION: "europe-west4" } as NodeJS.ProcessEnv),
    ).toBe("europe-west4");
  });

  it("parses regional Vertex endpoints", () => {
    expect(
      resolveGoogleVertexRegionFromBaseUrl("https://europe-west4-aiplatform.googleapis.com"),
    ).toBe("europe-west4");
  });

  it("treats the global Vertex endpoint as global", () => {
    expect(resolveGoogleVertexRegionFromBaseUrl("https://aiplatform.googleapis.com")).toBe(
      "global",
    );
  });

  it("does not infer a Vertex region from custom proxy hosts", () => {
    expect(
      resolveGoogleVertexRegionFromBaseUrl("https://proxy.example.com/google/aiplatform"),
    ).toBeUndefined();
  });

  it("prefers baseUrl region over env region", () => {
    expect(
      resolveGoogleVertexClientRegion({
        baseUrl: "https://us-east1-aiplatform.googleapis.com",
        env: { GOOGLE_CLOUD_LOCATION: "europe-west4" } as NodeJS.ProcessEnv,
      }),
    ).toBe("us-east1");
  });

  it("returns env region when baseUrl is not Vertex", () => {
    expect(
      resolveGoogleVertexClientRegion({
        baseUrl: "https://proxy.example.com",
        env: { GOOGLE_CLOUD_LOCATION: "europe-west4" } as NodeJS.ProcessEnv,
      }),
    ).toBe("europe-west4");
  });

  it("returns undefined when no region can be resolved", () => {
    expect(resolveGoogleVertexClientRegion({ env: {} as NodeJS.ProcessEnv })).toBeUndefined();
  });

  it("builds the global base URL for the global region", () => {
    expect(resolveGoogleVertexBaseUrl("global")).toBe("https://aiplatform.googleapis.com");
  });

  it("builds regional base URLs", () => {
    expect(resolveGoogleVertexBaseUrl("us-central1")).toBe(
      "https://us-central1-aiplatform.googleapis.com",
    );
  });

  it("returns no synthetic api key when ADC is not readable", () => {
    expect(
      resolveGoogleVertexConfigApiKey({
        GOOGLE_APPLICATION_CREDENTIALS: "/no/such/path/adc.json",
        HOME: "/no/such/home",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});
