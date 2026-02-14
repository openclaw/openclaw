import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkOllamaHealth, listOllamaModels, getOllamaRunningModels } from "./ollama-health.js";

const BASE = "http://127.0.0.1:11434";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

function err() {
  return Promise.reject(new Error("fetch failed"));
}

describe("checkOllamaHealth", () => {
  it("returns healthy with version", async () => {
    fetchMock.mockReturnValue(ok({ version: "0.6.2" }));
    const result = await checkOllamaHealth(BASE);
    expect(result).toEqual({ healthy: true, version: "0.6.2" });
  });

  it("returns unhealthy on connection error", async () => {
    fetchMock.mockReturnValue(err());
    const result = await checkOllamaHealth(BASE);
    expect(result.healthy).toBe(false);
    expect((result as any).error).toContain("fetch failed");
  });

  it("returns unhealthy on malformed response", async () => {
    fetchMock.mockReturnValue(ok({ unexpected: true }));
    const result = await checkOllamaHealth(BASE);
    expect(result).toEqual({ healthy: false, error: "Unexpected response from /api/version" });
  });

  it("handles timeout (AbortError)", async () => {
    fetchMock.mockImplementation(() => {
      const e = new DOMException("The operation was aborted", "AbortError");
      return Promise.reject(e);
    });
    const result = await checkOllamaHealth(BASE);
    expect(result).toEqual({ healthy: false, error: "Connection timed out" });
  });
});

describe("listOllamaModels", () => {
  it("parses model list", async () => {
    fetchMock.mockReturnValue(
      ok({
        models: [
          {
            name: "llama3:latest",
            size: 4_000_000_000,
            modified_at: "2024-01-01T00:00:00Z",
            digest: "abc123",
          },
          {
            name: "codellama:7b",
            size: 3_500_000_000,
            modified_at: "2024-02-01T00:00:00Z",
            digest: "def456",
          },
        ],
      }),
    );
    const models = await listOllamaModels(BASE);
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      name: "llama3:latest",
      size: 4_000_000_000,
      modifiedAt: "2024-01-01T00:00:00Z",
      digest: "abc123",
    });
  });

  it("returns empty array when no models pulled", async () => {
    fetchMock.mockReturnValue(ok({ models: [] }));
    const models = await listOllamaModels(BASE);
    expect(models).toEqual([]);
  });

  it("returns empty array on error", async () => {
    fetchMock.mockReturnValue(err());
    const models = await listOllamaModels(BASE);
    expect(models).toEqual([]);
  });

  it("returns empty array on malformed response", async () => {
    fetchMock.mockReturnValue(ok("not json object"));
    const models = await listOllamaModels(BASE);
    expect(models).toEqual([]);
  });
});

describe("getOllamaRunningModels", () => {
  it("parses running models with VRAM info", async () => {
    fetchMock.mockReturnValue(
      ok({
        models: [
          {
            name: "llama3:latest",
            size: 4_000_000_000,
            size_vram: 4_000_000_000,
            digest: "abc123",
            expires_at: "2024-01-01T01:00:00Z",
          },
        ],
      }),
    );
    const running = await getOllamaRunningModels(BASE);
    expect(running).toHaveLength(1);
    expect(running[0]).toEqual({
      name: "llama3:latest",
      size: 4_000_000_000,
      sizeVram: 4_000_000_000,
      digest: "abc123",
      expiresAt: "2024-01-01T01:00:00Z",
    });
  });

  it("returns empty array on error", async () => {
    fetchMock.mockReturnValue(err());
    const running = await getOllamaRunningModels(BASE);
    expect(running).toEqual([]);
  });
});
