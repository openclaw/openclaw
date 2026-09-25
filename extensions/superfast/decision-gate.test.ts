// Unit tests for the Superfast decision gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GATE_SETTINGS,
  classifyTurn,
  probeBackend,
  querySystemOne,
  resolveGateSettings,
  type DecisionGateSettings,
} from "./decision-gate.js";

function settingsWith(overrides: Partial<DecisionGateSettings> = {}): DecisionGateSettings {
  return { ...DEFAULT_GATE_SETTINGS, enabled: true, ...overrides };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("resolveGateSettings", () => {
  it("returns defaults when no input is given", () => {
    expect(resolveGateSettings()).toEqual(DEFAULT_GATE_SETTINGS);
  });

  it("is disabled by default", () => {
    expect(resolveGateSettings({}).enabled).toBe(false);
  });

  it("applies overrides", () => {
    const s = resolveGateSettings({
      enabled: true,
      endpoint: "http://x:9/v1/systemone",
      model: "von-9",
      timeoutMs: 50,
    });
    expect(s).toEqual({
      enabled: true,
      endpoint: "http://x:9/v1/systemone",
      model: "von-9",
      timeoutMs: 50,
    });
  });

  it("falls back to the default timeout for non-positive or non-numeric values", () => {
    expect(resolveGateSettings({ timeoutMs: 0 }).timeoutMs).toBe(DEFAULT_GATE_SETTINGS.timeoutMs);
    expect(resolveGateSettings({ timeoutMs: -5 }).timeoutMs).toBe(DEFAULT_GATE_SETTINGS.timeoutMs);
  });

  it("ignores empty-string endpoint/model and keeps defaults", () => {
    const s = resolveGateSettings({ endpoint: "", model: "" });
    expect(s.endpoint).toBe(DEFAULT_GATE_SETTINGS.endpoint);
    expect(s.model).toBe(DEFAULT_GATE_SETTINGS.model);
  });
});

describe("querySystemOne", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed answers on success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ answers: { needs_tool: { noul: 0.9 } } }));
    const answers = await querySystemOne(
      "hi",
      { needs_tool: { type: "noul", instructions: "need a tool?" } },
      settingsWith(),
    );
    expect(answers).toEqual({ needs_tool: { noul: 0.9 } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(DEFAULT_GATE_SETTINGS.endpoint);
    expect(JSON.parse(init.body).model).toBe(DEFAULT_GATE_SETTINGS.model);
  });

  it("fails open (null) on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 503));
    const answers = await querySystemOne(
      "hi",
      { a: { type: "noul", instructions: "x" } },
      settingsWith(),
    );
    expect(answers).toBeNull();
  });

  it("fails open (null) on a malformed response body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }));
    const answers = await querySystemOne(
      "hi",
      { a: { type: "noul", instructions: "x" } },
      settingsWith(),
    );
    expect(answers).toBeNull();
  });

  it("fails open (null) on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const answers = await querySystemOne(
      "hi",
      { a: { type: "noul", instructions: "x" } },
      settingsWith(),
    );
    expect(answers).toBeNull();
  });

  it("propagates the caller abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(new Error("aborted"));
    await expect(
      querySystemOne(
        "hi",
        { a: { type: "noul", instructions: "x" } },
        settingsWith(),
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});

describe("classifyTurn", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when disabled (no network call)", async () => {
    const decision = await classifyTurn("hi", {
      ...DEFAULT_GATE_SETTINGS,
      enabled: false,
    });
    expect(decision).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes needs_tool when the tool probability is decisive", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        answers: {
          needs_tool: { noul: 0.95 },
          answerable_from_context: { noul: 0.1 },
          intent: { choice: "code_change", confidence: 0.9 },
        },
      }),
    );
    const decision = await classifyTurn("delete the tmp dir", settingsWith());
    expect(decision?.route).toBe("needs_tool");
  });

  it("routes answer_from_context when strongly answerable and low tool need", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        answers: {
          needs_tool: { noul: 0.1 },
          answerable_from_context: { noul: 0.92 },
          intent: { choice: "code_question", confidence: 0.8 },
        },
      }),
    );
    const decision = await classifyTurn("what did we just change?", settingsWith());
    expect(decision?.route).toBe("answer_from_context");
  });

  it("routes plain_chat for obvious chat with no tool need", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        answers: {
          needs_tool: { noul: 0.05 },
          answerable_from_context: { noul: 0.4 },
          intent: { choice: "chat", confidence: 0.95 },
        },
      }),
    );
    const decision = await classifyTurn("thanks!", settingsWith());
    expect(decision?.route).toBe("plain_chat");
  });

  it("routes unknown when signals are not decisive", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        answers: {
          needs_tool: { noul: 0.5 },
          answerable_from_context: { noul: 0.5 },
          intent: { choice: "other", confidence: 0.4 },
        },
      }),
    );
    const decision = await classifyTurn("hmm", settingsWith());
    expect(decision?.route).toBe("unknown");
  });

  it("returns null when the backend is unavailable (fail-open)", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const decision = await classifyTurn("hi", settingsWith());
    expect(decision).toBeNull();
  });
});

describe("probeBackend", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when the endpoint answers a noul", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ answers: { ok: { noul: 0.7 } } }));
    await expect(probeBackend(settingsWith())).resolves.toBe(true);
  });

  it("returns false when the endpoint is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(probeBackend(settingsWith())).resolves.toBe(false);
  });
});
