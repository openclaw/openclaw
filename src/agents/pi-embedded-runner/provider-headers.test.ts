import { describe, expect, it } from "vitest";
import {
  hasHeaderTemplates,
  interpolateHeaderValue,
  resolveProviderHeaders,
} from "./provider-headers.js";

describe("interpolateHeaderValue", () => {
  it("replaces {{session.key}} and {{agent.id}}", () => {
    expect(
      interpolateHeaderValue("affinity-{{session.key}}-{{agent.id}}", {
        sessionKey: "sk1",
        agentId: "agent-a",
      }),
    ).toBe("affinity-sk1-agent-a");
  });

  it("replaces only session.key when agentId missing", () => {
    expect(
      interpolateHeaderValue("{{session.key}}", { sessionKey: "s1", agentId: undefined }),
    ).toBe("s1");
  });

  it("replaces missing vars with empty string", () => {
    expect(interpolateHeaderValue("{{session.key}}-{{agent.id}}", {})).toBe("-");
  });

  it("leaves unknown placeholders unchanged", () => {
    expect(interpolateHeaderValue("{{session.key}}-{{unknown.var}}", { sessionKey: "s1" })).toBe(
      "s1-{{unknown.var}}",
    );
  });

  it("leaves static values unchanged", () => {
    expect(interpolateHeaderValue("static-value", { sessionKey: "s1" })).toBe("static-value");
  });
});

describe("resolveProviderHeaders", () => {
  it("returns empty object for undefined or empty headers", () => {
    expect(resolveProviderHeaders(undefined, { sessionKey: "s1" })).toEqual({});
    expect(resolveProviderHeaders({}, { sessionKey: "s1" })).toEqual({});
  });

  it("interpolates all header values", () => {
    expect(
      resolveProviderHeaders(
        {
          "x-session-affinity": "{{session.key}}",
          "x-agent-id": "{{agent.id}}",
        },
        { sessionKey: "my-session", agentId: "my-agent" },
      ),
    ).toEqual({
      "x-session-affinity": "my-session",
      "x-agent-id": "my-agent",
    });
  });

  it("skips non-string values", () => {
    const headers = {
      a: "ok",
      b: 1 as unknown as string,
    };
    expect(resolveProviderHeaders(headers, {})).toEqual({ a: "ok" });
  });
});

describe("hasHeaderTemplates", () => {
  it("returns false for undefined or empty", () => {
    expect(hasHeaderTemplates(undefined)).toBe(false);
    expect(hasHeaderTemplates({})).toBe(false);
  });

  it("returns true when any value contains {{", () => {
    expect(hasHeaderTemplates({ "x-affinity": "{{session.key}}" })).toBe(true);
    expect(hasHeaderTemplates({ a: "static", b: "{{agent.id}}" })).toBe(true);
  });

  it("returns false when no value contains {{", () => {
    expect(hasHeaderTemplates({ "x-foo": "static" })).toBe(false);
  });
});
