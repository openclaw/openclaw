import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  DesktopLaunchParamsSchema,
  DesktopObserveResultSchema,
  WorkerDesktopObserveResultSchema,
  validateDesktopObserveParams,
} from "../index.js";

const observed = {
  transport: "rfb",
  wsPath: "/desktop/observe?token=abc",
  expiresAtMs: 1,
  control: false,
};
const host = { kind: "host" };
const environment = { kind: "environment", environmentId: "worker:one" };
const node = { kind: "node", nodeId: "one" };
const credentials = { username: "operator", password: "secret" };

describe("desktop protocol schemas", () => {
  it("advertises optional receive-only PCM audio with a fixed format", () => {
    const audio = {
      wsPath: "/desktop/audio",
      encoding: "pcm-s16le",
      sampleRate: 48000,
      channels: 2,
    };
    for (const result of [
      observed,
      { ...observed, audio },
      { ...observed, audioUnavailableReason: "setup-unavailable" },
    ]) {
      expect(Value.Check(DesktopObserveResultSchema, result)).toBe(true);
    }
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
      const result = { ...observed, control: true };
      expect(Value.Check(schema, result)).toBe(true);
      for (const canResize of [true, false, "true"]) {
        expect(Value.Check(schema, { ...result, canResize })).toBe(typeof canResize === "boolean");
      }
    },
  );
  it("accepts host, environment, and node observe sources", () => {
    for (const params of [
      { source: host, control: true },
      { source: host, credentials },
      { source: environment },
      { source: node },
      { source: node, credentials },
      { source: node, credentials: { password: "secret" } },
    ]) {
      expect(validateDesktopObserveParams(params)).toBe(true);
    }
    for (const params of [
      { source: { kind: "node", nodeId: "" } },
      { source: { kind: "future" } },
      { source: environment, credentials: { password: "secret" } },
      { source: host, credentials: { ...credentials, username: "" } },
      { source: { ...host, environmentId: "one" } },
    ]) {
      expect(validateDesktopObserveParams(params)).toBe(false);
    }
  });

  it("keeps launch environment-only and desktop auth additive", () => {
    expect(Value.Check(DesktopLaunchParamsSchema, { source: environment, app: "browser" })).toBe(
      true,
    );
    expect(Value.Check(DesktopLaunchParamsSchema, { source: host, app: "browser" })).toBe(false);
    expect(
      Value.Check(DesktopObserveResultSchema, {
        ...observed,
        auth: "ard-account",
        preauthenticated: true,
      }),
    ).toBe(true);
    expect(Value.Check(DesktopObserveResultSchema, { ...observed, auth: "vencrypt" })).toBe(false);
  });
});
