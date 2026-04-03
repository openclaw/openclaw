import { describe, expect, it, vi, beforeEach } from "vitest";
import { GET, POST } from "./route";

vi.mock("@/lib/dench-cloud-settings", () => ({
  getCloudSettingsState: vi.fn(),
  saveApiKey: vi.fn(),
  saveVoiceId: vi.fn(),
  selectModel: vi.fn(),
}));

const {
  getCloudSettingsState,
  saveApiKey,
  saveVoiceId,
  selectModel,
} = await import("@/lib/dench-cloud-settings");

const mockedGet = vi.mocked(getCloudSettingsState);
const mockedSaveKey = vi.mocked(saveApiKey);
const mockedSaveVoice = vi.mocked(saveVoiceId);
const mockedSelectModel = vi.mocked(selectModel);

const validState = {
  status: "valid" as const,
  apiKeySource: "config" as const,
  gatewayUrl: "https://gateway.merseoriginals.com",
  primaryModel: "dench-cloud/anthropic.claude-opus-4-6-v1",
  isDenchPrimary: true,
  selectedDenchModel: "anthropic.claude-opus-4-6-v1",
  selectedVoiceId: "voice_123",
  elevenLabsEnabled: true,
  models: [
    {
      id: "claude-opus-4.6",
      stableId: "anthropic.claude-opus-4-6-v1",
      displayName: "Claude Opus 4.6",
      provider: "anthropic",
      transportProvider: "bedrock",
      api: "openai-completions" as const,
      input: ["text" as const, "image" as const],
      reasoning: false,
      contextWindow: 200000,
      maxTokens: 64000,
      supportsStreaming: true,
      supportsImages: true,
      supportsResponses: true,
      supportsReasoning: false,
      cost: { input: 6.75, output: 33.75, cacheRead: 0, cacheWrite: 0, marginPercent: 0.35 },
    },
  ],
  recommendedModelId: "claude-opus-4.6",
};

const noKeyState = {
  ...validState,
  status: "no_key" as const,
  apiKeySource: "missing" as const,
  isDenchPrimary: false,
  selectedDenchModel: null,
  models: [],
};

const refreshOk = { attempted: true, restarted: true, error: null, profile: "dench" };

describe("cloud settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET returns current cloud settings state", async () => {
    mockedGet.mockResolvedValue(validState);
    const res = await GET();
    const body = await res.json();
    expect(body.status).toBe("valid");
    expect(body.isDenchPrimary).toBe(true);
  });

  it("GET returns 500 on error", async () => {
    mockedGet.mockRejectedValue(new Error("read failed"));
    const res = await GET();
    expect(res.status).toBe(500);
  });

  it("POST save_key validates and persists key", async () => {
    mockedSaveKey.mockResolvedValue({ state: validState, changed: true, refresh: refreshOk });
    const req = new Request("http://localhost/api/settings/cloud", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_key", apiKey: "dench_test_key" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.changed).toBe(true);
    expect(body.refresh.restarted).toBe(true);
    expect(mockedSaveKey).toHaveBeenCalledWith("dench_test_key");
  });

  it("POST save_key rejects empty key", async () => {
    const req = new Request("http://localhost/api/settings/cloud", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_key", apiKey: "" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("POST save_key returns 409 on validation error", async () => {
    mockedSaveKey.mockResolvedValue({
      state: noKeyState,
      changed: false,
      refresh: { attempted: false, restarted: false, error: null, profile: "default" },
      error: "Invalid Dench Cloud API key.",
    });
    const req = new Request("http://localhost/api/settings/cloud", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_key", apiKey: "bad_key" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Invalid");
  });

  it("POST select_model switches primary model", async () => {
    mockedSelectModel.mockResolvedValue({ state: validState, changed: true, refresh: refreshOk });
    const req = new Request("http://localhost/api/settings/cloud", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "select_model", stableId: "gpt-5.4" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.changed).toBe(true);
    expect(mockedSelectModel).toHaveBeenCalledWith("gpt-5.4");
  });

  it("POST select_model rejects empty stableId", async () => {
    const req = new Request("http://localhost/api/settings/cloud", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "select_model", stableId: "" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("POST save_voice persists the selected voice", async () => {
    mockedSaveVoice.mockResolvedValue({ state: validState, changed: true, refresh: refreshOk });
    const req = new Request("http://localhost/api/settings/cloud", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_voice", voiceId: "voice_123" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockedSaveVoice).toHaveBeenCalledWith("voice_123");
  });

  it("POST save_voice rejects invalid voice payloads", async () => {
    const req = new Request("http://localhost/api/settings/cloud", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_voice", voiceId: 123 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("POST rejects unknown actions", async () => {
    const req = new Request("http://localhost/api/settings/cloud", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_key" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unknown action");
  });
});
