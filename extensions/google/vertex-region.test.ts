import { describe, expect, it } from "vitest";
import {
  buildGoogleVertexBaseUrl,
  resolveGoogleVertexProjectId,
  resolveGoogleVertexRegion,
  resolveGoogleVertexRegionFromBaseUrl,
} from "./vertex-region.js";

describe("google vertex region helpers", () => {
  describe("resolveGoogleVertexRegion", () => {
    it("uses GOOGLE_CLOUD_LOCATION when set", () => {
      expect(
        resolveGoogleVertexRegion({
          GOOGLE_CLOUD_LOCATION: "europe-west4",
        } as NodeJS.ProcessEnv),
      ).toBe("europe-west4");
    });

    it("falls back to CLOUD_ML_REGION", () => {
      expect(
        resolveGoogleVertexRegion({
          CLOUD_ML_REGION: "asia-east1",
        } as NodeJS.ProcessEnv),
      ).toBe("asia-east1");
    });

    it("prefers GOOGLE_CLOUD_LOCATION over CLOUD_ML_REGION", () => {
      expect(
        resolveGoogleVertexRegion({
          GOOGLE_CLOUD_LOCATION: "us-west1",
          CLOUD_ML_REGION: "us-east1",
        } as NodeJS.ProcessEnv),
      ).toBe("us-west1");
    });

    it("defaults to us-central1 when no env is set", () => {
      expect(resolveGoogleVertexRegion({} as NodeJS.ProcessEnv)).toBe("us-central1");
    });

    it("rejects malformed region values", () => {
      expect(
        resolveGoogleVertexRegion({
          GOOGLE_CLOUD_LOCATION: "us-central1.attacker.example",
        } as NodeJS.ProcessEnv),
      ).toBe("us-central1");
    });

    it("rejects empty and whitespace-only values", () => {
      expect(
        resolveGoogleVertexRegion({
          GOOGLE_CLOUD_LOCATION: "  ",
        } as NodeJS.ProcessEnv),
      ).toBe("us-central1");
    });
  });

  describe("resolveGoogleVertexProjectId", () => {
    it("resolves from GOOGLE_CLOUD_PROJECT", () => {
      expect(
        resolveGoogleVertexProjectId({
          GOOGLE_CLOUD_PROJECT: "my-project",
        } as NodeJS.ProcessEnv),
      ).toBe("my-project");
    });

    it("falls back to GOOGLE_CLOUD_PROJECT_ID", () => {
      expect(
        resolveGoogleVertexProjectId({
          GOOGLE_CLOUD_PROJECT_ID: "other-project",
        } as NodeJS.ProcessEnv),
      ).toBe("other-project");
    });

    it("prefers GOOGLE_CLOUD_PROJECT over GOOGLE_CLOUD_PROJECT_ID", () => {
      expect(
        resolveGoogleVertexProjectId({
          GOOGLE_CLOUD_PROJECT: "primary",
          GOOGLE_CLOUD_PROJECT_ID: "secondary",
        } as NodeJS.ProcessEnv),
      ).toBe("primary");
    });

    it("returns undefined when no project env is set", () => {
      expect(resolveGoogleVertexProjectId({} as NodeJS.ProcessEnv)).toBeUndefined();
    });
  });

  describe("resolveGoogleVertexRegionFromBaseUrl", () => {
    it("extracts region from a regional Vertex endpoint", () => {
      expect(
        resolveGoogleVertexRegionFromBaseUrl("https://us-central1-aiplatform.googleapis.com"),
      ).toBe("us-central1");
    });

    it("returns global for the global Vertex endpoint", () => {
      expect(resolveGoogleVertexRegionFromBaseUrl("https://aiplatform.googleapis.com")).toBe(
        "global",
      );
    });

    it("returns undefined for non-Vertex endpoints", () => {
      expect(
        resolveGoogleVertexRegionFromBaseUrl("https://generativelanguage.googleapis.com/v1beta"),
      ).toBeUndefined();
    });

    it("returns undefined for proxy hosts", () => {
      expect(
        resolveGoogleVertexRegionFromBaseUrl("https://proxy.example.com/aiplatform"),
      ).toBeUndefined();
    });
  });

  describe("buildGoogleVertexBaseUrl", () => {
    it("builds a regional Vertex AI base URL", () => {
      expect(buildGoogleVertexBaseUrl({ region: "us-central1", projectId: "my-project" })).toBe(
        "https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/google",
      );
    });

    it("builds a global Vertex AI base URL", () => {
      expect(buildGoogleVertexBaseUrl({ region: "global", projectId: "my-project" })).toBe(
        "https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/google",
      );
    });

    it("encodes special characters in project ID", () => {
      const url = buildGoogleVertexBaseUrl({
        region: "us-central1",
        projectId: "my project/id",
      });
      expect(url).toContain("my%20project%2Fid");
    });

    it("uses correct endpoint for europe-west4", () => {
      expect(buildGoogleVertexBaseUrl({ region: "europe-west4", projectId: "eu-proj" })).toBe(
        "https://europe-west4-aiplatform.googleapis.com/v1/projects/eu-proj/locations/europe-west4/publishers/google",
      );
    });
  });
});
