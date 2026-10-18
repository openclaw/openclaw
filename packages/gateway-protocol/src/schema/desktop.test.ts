import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  DesktopLaunchParamsSchema,
  DesktopObserveResultSchema,
  WorkerDesktopObserveResultSchema,
  validateDesktopObserveParams,
} from "../index.js";

describe("desktop protocol schemas", () => {
  it("advertises optional receive-only PCM audio with a fixed format", () => {
    const observed = {
      transport: "rfb",
      wsPath: "/desktop/observe",
      expiresAtMs: 1,
      control: false,
    };
    const audio = {
      wsPath: "/desktop/audio",
      encoding: "pcm-s16le",
      sampleRate: 48000,
      channels: 2,
    };
    expect(Value.Check(DesktopObserveResultSchema, observed)).toBe(true);
    expect(Value.Check(DesktopObserveResultSchema, { ...observed, audio })).toBe(true);
    expect(
      Value.Check(DesktopObserveResultSchema, {
        ...observed,
        audioUnavailableReason: "setup-unavailable",
      }),
    ).toBe(true);
    expect(
      Value.Check(DesktopObserveResultSchema, {
        ...observed,
        audioUnavailableReason: "native stderr /private/path",
      }),
    ).toBe(false);
    for (const invalid of [
      { encoding: "opus" },
      { sampleRate: 24000 },
      { channels: 1 },
      { microphone: true },
    ]) {
      expect(
        Value.Check(DesktopObserveResultSchema, { ...observed, audio: { ...audio, ...invalid } }),
      ).toBe(false);
    }
  });
  it.each([DesktopObserveResultSchema, WorkerDesktopObserveResultSchema])(
    "keeps resize permission optional and boolean",
    (schema) => {
      const observed = {
        transport: "rfb",
        wsPath: "/desktop/observe?token=abc",
        expiresAtMs: 1,
        control: true,
      };
      expect(Value.Check(schema, observed)).toBe(true);
      for (const canResize of [true, false, "true"]) {
        expect(Value.Check(schema, { ...observed, canResize })).toBe(
          typeof canResize === "boolean",
        );
      }
    },
  );
  it("accepts host, environment, and node observe sources", () => {
    expect(validateDesktopObserveParams({ source: { kind: "host" }, control: true })).toBe(true);
    expect(
      validateDesktopObserveParams({
        source: { kind: "host" },
        credentials: { username: "operator", password: "secret" },
      }),
    ).toBe(true);
    expect(
      validateDesktopObserveParams({
        source: { kind: "environment", environmentId: "worker:one" },
      }),
    ).toBe(true);
    expect(validateDesktopObserveParams({ source: { kind: "node", nodeId: "one" } })).toBe(true);
    expect(
      validateDesktopObserveParams({
        source: { kind: "node", nodeId: "one" },
        credentials: { username: "operator", password: "secret" },
      }),
    ).toBe(true);
    expect(
      validateDesktopObserveParams({
        source: { kind: "node", nodeId: "one" },
        credentials: { password: "secret" },
      }),
    ).toBe(true);
    expect(validateDesktopObserveParams({ source: { kind: "node", nodeId: "" } })).toBe(false);
    expect(validateDesktopObserveParams({ source: { kind: "future" } })).toBe(false);
    expect(
      validateDesktopObserveParams({
        source: { kind: "environment", environmentId: "worker:one" },
        credentials: { password: "secret" },
      }),
    ).toBe(false);
    expect(
      validateDesktopObserveParams({
        source: { kind: "host" },
        credentials: { username: "", password: "secret" },
      }),
    ).toBe(false);
    expect(validateDesktopObserveParams({ source: { kind: "host", environmentId: "one" } })).toBe(
      false,
    );
  });

  it("keeps launch environment-only and desktop auth additive", () => {
    expect(
      Value.Check(DesktopLaunchParamsSchema, {
        source: { kind: "environment", environmentId: "worker:one" },
        app: "browser",
      }),
    ).toBe(true);
    expect(
      Value.Check(DesktopLaunchParamsSchema, { source: { kind: "host" }, app: "browser" }),
    ).toBe(false);
    expect(
      Value.Check(DesktopObserveResultSchema, {
        transport: "rfb",
        wsPath: "/desktop/observe?token=abc",
        expiresAtMs: 1,
        control: false,
        auth: "ard-account",
        preauthenticated: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(DesktopObserveResultSchema, {
        transport: "rfb",
        wsPath: "/desktop/observe?token=abc",
        expiresAtMs: 1,
        control: false,
        auth: "vencrypt",
      }),
    ).toBe(false);
  });
});
