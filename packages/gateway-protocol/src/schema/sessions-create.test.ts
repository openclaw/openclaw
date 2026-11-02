import { describe, expect, it } from "vitest";
import {
  SESSION_CREATE_IDEMPOTENCY_RETENTION_MS,
  SESSION_CREATE_RETRY_WINDOW_MS,
  validateSessionsCreateParams,
} from "../index.js";

describe("sessions.create schema", () => {
  it("accepts only the dock presentation surface without accepting creator attribution", () => {
    expect(validateSessionsCreateParams({ surface: "plugin-dock" })).toBe(true);
    for (const surface of ["operator", "spawn", "internal", "plugin", "", null]) {
      expect(validateSessionsCreateParams({ surface })).toBe(false);
    }
    expect(validateSessionsCreateParams({ createdVia: "plugin-dock" })).toBe(false);
    expect(
      validateSessionsCreateParams({ surface: "plugin-dock", createdActor: { type: "system" } }),
    ).toBe(false);
  });
  it("retains successful creates beyond the client's bounded retry window", () => {
    expect(SESSION_CREATE_RETRY_WINDOW_MS).toBe(4 * 60_000);
    expect(SESSION_CREATE_IDEMPOTENCY_RETENTION_MS).toBeGreaterThan(SESSION_CREATE_RETRY_WINDOW_MS);
  });

  it("rejects unknown permission modes", () => {
    expect(validateSessionsCreateParams({ agentId: "main", permissionMode: "unrestricted" })).toBe(
      false,
    );
  });
});
