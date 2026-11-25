import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMockState = vi.hoisted(() => ({
  getMSTeamsRuntime: vi.fn(),
  runtime: { version: "2026.3.19" },
}));
const mockRuntime = runtimeMockState.runtime;

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: runtimeMockState.getMSTeamsRuntime,
}));

vi.mock("../runtime-api.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../runtime-api.js")>();
  return {
    ...original,
    fetchWithSsrFGuard: async (params: { url: string; init?: RequestInit }) => ({
      response: await globalThis.fetch(params.url, params.init),
      finalUrl: params.url,
      release: async () => undefined,
    }),
  };
});

import { fetchGraphJson } from "./graph.js";
import { getMSTeamsRuntime } from "./runtime.js";

let buildUserAgent: typeof import("./user-agent.js").buildUserAgent;
let ensureUserAgentHeader: typeof import("./user-agent.js").ensureUserAgentHeader;

async function fetchGraphHeaders(headers?: Record<string, string>) {
  const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ value: [] }));
  vi.stubGlobal("fetch", mockFetch);
  await fetchGraphJson({ token: "test-token", path: "/groups", headers });
  expect(mockFetch).toHaveBeenCalledOnce();
  return new Headers(mockFetch.mock.calls[0]?.[1]?.headers);
}

describe("buildUserAgent", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ buildUserAgent, ensureUserAgentHeader } = await import("./user-agent.js"));
    vi.mocked(getMSTeamsRuntime).mockReturnValue(mockRuntime as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reflects the runtime version", () => {
    vi.mocked(getMSTeamsRuntime).mockReturnValue({ version: "1.2.3" } as never);
    const ua = buildUserAgent();
    expect(ua).toMatch(/OpenClaw\/1\.2\.3$/);
  });

  it("returns OpenClaw/unknown when runtime is not initialized", () => {
    vi.mocked(getMSTeamsRuntime).mockImplementation(() => {
      throw new Error("MSTeams runtime not initialized");
    });
    const ua = buildUserAgent();
    expect(ua).toMatch(/OpenClaw\/unknown$/);
    expect(ua).toMatch(/^teams\.ts\[apps\]\//);
  });

  it("sends the generated User-Agent in Graph requests by default", async () => {
    const headers = await fetchGraphHeaders();
    expect(headers.get("User-Agent")).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/2026\.3\.19$/);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
  });

  it("lets caller headers override the default Graph User-Agent", async () => {
    const headers = await fetchGraphHeaders({ "User-Agent": "custom-agent/1.0" });
    expect(headers.get("User-Agent")).toBe("custom-agent/1.0");
  });

  it("adds the generated User-Agent to Headers instances without overwriting callers", () => {
    const generated = ensureUserAgentHeader();
    expect(generated.get("User-Agent")).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/2026\.3\.19$/);

    const custom = ensureUserAgentHeader({ "User-Agent": "custom-agent/2.0" });
    expect(custom.get("User-Agent")).toBe("custom-agent/2.0");
  });
});
