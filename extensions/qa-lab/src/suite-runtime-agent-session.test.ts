import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  readEffectiveTools,
  readRawQaSessionEntries,
  readSkillStatus,
} from "./suite-runtime-agent-session.js";

describe("qa suite runtime agent session helpers", () => {
  const gatewayCall = vi.fn();
  const env = {
    gateway: { call: gatewayCall },
    primaryModel: "openai/gpt-5.5",
    alternateModel: "openai/gpt-5.5-mini",
    providerMode: "mock-openai",
  } as never;

  beforeEach(() => {
    gatewayCall.mockReset();
  });

  it("creates sessions and trims the returned key", async () => {
    gatewayCall.mockResolvedValueOnce({ key: "  session-1  " });

    await expect(createSession(env, "Test Session")).resolves.toBe("session-1");
    expect(gatewayCall).toHaveBeenCalledWith(
      "sessions.create",
      { label: "Test Session" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("reads effective tool ids once and drops blanks", async () => {
    gatewayCall.mockResolvedValueOnce({
      groups: [
        { tools: [{ id: "alpha" }, { id: " beta " }] },
        { tools: [{ id: "alpha" }, { id: "" }, {}] },
      ],
    });

    await expect(readEffectiveTools(env, "session-1")).resolves.toEqual(new Set(["alpha", "beta"]));
  });

  it("reads skill status for the default qa agent", async () => {
    gatewayCall.mockResolvedValueOnce({
      skills: [{ name: "alpha", eligible: true }],
    });

    await expect(readSkillStatus(env)).resolves.toEqual([{ name: "alpha", eligible: true }]);
    expect(gatewayCall).toHaveBeenCalledWith(
      "skills.status",
      { agentId: "qa" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("reads the raw qa session entries through the gateway", async () => {
    gatewayCall.mockResolvedValueOnce({
      sessions: [
        {
          key: "session-1",
          sessionId: "session-1",
          status: "running",
          label: "QA",
          updatedAt: 123,
        },
        {
          key: "",
          sessionId: "blank",
        },
      ],
    });

    await expect(readRawQaSessionEntries(env)).resolves.toEqual({
      "session-1": {
        sessionId: "session-1",
        status: "running",
        label: "QA",
        updatedAt: 123,
      },
    });
    expect(gatewayCall).toHaveBeenCalledWith(
      "sessions.list",
      {
        agentId: "qa",
        includeGlobal: true,
        includeUnknown: true,
        limit: 1000,
      },
      { timeoutMs: 45_000 },
    );
  });

  it("returns an empty session entry map when the gateway returns no sessions", async () => {
    gatewayCall.mockResolvedValueOnce({});

    await expect(readRawQaSessionEntries(env)).resolves.toEqual({});
  });
});
