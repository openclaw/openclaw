import { describe, expect, it } from "vitest";
import type { ManifestResponse } from "./types.js";
import { CloudClient } from "./cloud-client.js";

const SAMPLE_MANIFEST: ManifestResponse = {
  store: { name: "Test", version: "v1" },
  syncIntervalSeconds: 60,
  blocklist: ["evil"],
  skills: {
    "good-skill": {
      version: "1.0.0",
      fileCount: 1,
      files: { "SKILL.md": "abc123".repeat(10) + "abcd" },
    },
  },
};

function mockFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
): typeof globalThis.fetch {
  let call = 0;
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    const r = responses[call % responses.length];
    call++;
    return new Response(r.body !== undefined ? JSON.stringify(r.body) : null, {
      status: r.status,
      headers: { "Content-Type": "application/json", ...r.headers },
    });
  };
}

describe("CloudClient", () => {
  it("fetches manifest from the first store", async () => {
    const client = new CloudClient({
      stores: [{ url: "https://store1.test/api/v1/skill-guard" }],
      fetchImpl: mockFetch([{ status: 200, body: SAMPLE_MANIFEST }]),
    });
    const result = await client.fetchManifest();
    expect(result).not.toBeNull();
    expect(result!.store.version).toBe("v1");
  });

  it("returns null on 304 Not Modified", async () => {
    const client = new CloudClient({
      stores: [{ url: "https://store1.test/api/v1/skill-guard" }],
      fetchImpl: mockFetch([{ status: 304 }]),
    });
    const result = await client.fetchManifest("v1");
    expect(result).toBeNull();
  });

  it("falls through to second store on failure", async () => {
    let callCount = 0;
    const client = new CloudClient({
      stores: [
        { name: "Down", url: "https://down.test/api/v1/skill-guard" },
        { name: "Up", url: "https://up.test/api/v1/skill-guard" },
      ],
      fetchImpl: async (url: string | URL | Request) => {
        callCount++;
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (urlStr.includes("down.test")) {
          throw new Error("connection refused");
        }
        return new Response(JSON.stringify(SAMPLE_MANIFEST), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const result = await client.fetchManifest();
    expect(result).not.toBeNull();
    expect(callCount).toBe(2);
  });

  it("throws AggregateError when all stores fail", async () => {
    const client = new CloudClient({
      stores: [
        { url: "https://a.test/api/v1/skill-guard" },
        { url: "https://b.test/api/v1/skill-guard" },
      ],
      fetchImpl: async () => {
        throw new Error("network error");
      },
    });

    await expect(client.fetchManifest()).rejects.toThrow(/unreachable/);
  });

  it("fetchSingleSkill returns null on 404", async () => {
    const client = new CloudClient({
      stores: [{ url: "https://store.test/api/v1/skill-guard" }],
      fetchImpl: mockFetch([{ status: 404, body: { error: "skill_not_found" } }]),
    });
    const result = await client.fetchSingleSkill("nonexistent");
    expect(result).toBeNull();
  });

  it("fetchSingleSkill returns skill data on 200", async () => {
    const skillResp = {
      name: "good-skill",
      version: "1.0.0",
      fileCount: 1,
      files: { "SKILL.md": "abc" },
    };
    const client = new CloudClient({
      stores: [{ url: "https://store.test/api/v1/skill-guard" }],
      fetchImpl: mockFetch([{ status: 200, body: skillResp }]),
    });
    const result = await client.fetchSingleSkill("good-skill");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("good-skill");
  });
});
