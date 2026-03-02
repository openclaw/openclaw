/**
 * Regression tests for multi-account Matrix client resolution.
 *
 * Bug: in isolated sessions (cron/subagent), `accountId` is not propagated
 * through the tool→action→send path, causing `getAnyActiveMatrixClient()`
 * to be used as a last resort. That function returns the first client by Map
 * insertion order — which is non-deterministic under async startup races.
 *
 * See: openclaw/openclaw#26457
 */
import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAllActiveMatrixClients,
  getActiveMatrixClient,
  getAnyActiveMatrixClient,
  setActiveMatrixClient,
} from "./active-client.js";

vi.mock("@vector-im/matrix-bot-sdk", () => ({
  MatrixClient: vi.fn(),
}));

const makeClient = (name: string) => ({ _name: name }) as unknown as MatrixClient;

afterEach(() => {
  clearAllActiveMatrixClients();
});

describe("getActiveMatrixClient", () => {
  it("returns the client for a specific accountId", () => {
    const neko = makeClient("neko");
    const pyra = makeClient("pyra");

    setActiveMatrixClient(pyra, "pyra");
    setActiveMatrixClient(neko, "neko");

    expect(getActiveMatrixClient("neko")).toBe(neko);
    expect(getActiveMatrixClient("pyra")).toBe(pyra);
  });

  it("returns null for unknown accountId", () => {
    setActiveMatrixClient(makeClient("pyra"), "pyra");
    expect(getActiveMatrixClient("neko")).toBeNull();
  });

  it("is case-insensitive (normalised accountId)", () => {
    const neko = makeClient("neko");
    setActiveMatrixClient(neko, "Neko");
    expect(getActiveMatrixClient("neko")).toBe(neko);
  });
});

describe("getAnyActiveMatrixClient — demonstrates the race-condition risk", () => {
  it("returns first inserted client regardless of which accountId is needed", () => {
    const pyra = makeClient("pyra");
    const neko = makeClient("neko");

    // pyra starts first (as happened after the 2026-02-26 restart)
    setActiveMatrixClient(pyra, "pyra");
    setActiveMatrixClient(neko, "neko");

    // getAnyActiveMatrixClient blindly returns the first entry in Map order
    const resolved = getAnyActiveMatrixClient();
    expect(resolved).toBe(pyra); // ← wrong if neko was the intended sender

    // Correct resolution requires an explicit accountId lookup:
    expect(getActiveMatrixClient("neko")).toBe(neko);
  });
});

describe("getAnyActiveMatrixClient — warns in multi-account gateway mode", () => {
  it("emits console.warn when multiple clients are registered", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setActiveMatrixClient(makeClient("pyra"), "pyra");
      setActiveMatrixClient(makeClient("neko"), "neko");

      getAnyActiveMatrixClient();

      expect(warnSpy).toHaveBeenCalledOnce();
      // Warning must mention the account count so it's diagnosable in logs
      expect(warnSpy.mock.calls[0][0]).toContain("2");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when only one client is registered", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setActiveMatrixClient(makeClient("neko"), "neko");

      getAnyActiveMatrixClient();

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
