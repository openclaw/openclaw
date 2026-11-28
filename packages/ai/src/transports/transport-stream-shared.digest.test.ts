import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { parseTerminalToolCallArguments as parseArguments } from "./transport-stream-shared.js";

const initialHost = getAiTransportHost();

// Truncated buffers: valid JSON prefix, no closing brace.
const TRUNCATED = '{"path":"SECRET.md"';

type TerminalDiagnostics = {
  code: string;
  argumentChars: number;
  argumentHash: string;
  repairAttempted: boolean;
};

type CapturedError = Error & { cause?: TerminalDiagnostics; errorBody?: string };

afterEach(() => {
  configureAiTransportHost(initialHost);
  vi.restoreAllMocks();
});

describe("terminal argument digest", () => {
  it("uses the host-provided digest when one is configured", () => {
    configureAiTransportHost({
      ...initialHost,
      hashDiagnosticValue: (value: string) => `host:${value.length}`,
    });
    const thrown = captureError(() => parseArguments(TRUNCATED, undefined, undefined));
    expect(thrown.cause).toMatchObject({ argumentHash: `host:${TRUNCATED.length}` });
    expect(thrown.cause).toMatchObject({ argumentChars: TRUNCATED.length });
  });

  it("falls back to the plain digest when no host digest is available", () => {
    const thrown = captureError(() => parseArguments(TRUNCATED, undefined, undefined));
    expect(thrown.cause).toMatchObject({ argumentChars: TRUNCATED.length });
    expect(thrown.cause?.argumentHash).toMatch(/^[0-9a-z]+$/);
  });

  it("never exposes the rejected buffer in the digest", () => {
    configureAiTransportHost({
      ...initialHost,
      hashDiagnosticValue: (value: string) => `host:${value.length}`,
    });
    const thrown = captureError(() =>
      parseArguments('{"path":"SECRET.md","content":"hunter2"', undefined, undefined),
    );
    const surfaced = `${String(thrown)}${JSON.stringify(thrown.cause ?? null)}${thrown.errorBody ?? ""}`;
    expect(surfaced).not.toContain("SECRET.md");
    expect(surfaced).not.toContain("hunter2");
  });
});

function captureError(fn: () => unknown): CapturedError {
  try {
    fn();
  } catch (error) {
    return error as CapturedError;
  }
  throw new Error("expected parseArguments to throw");
}
