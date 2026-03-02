import { afterEach, describe, expect, it } from "vitest";
import type { RecoveryKeyHandler } from "./handler.js";
import {
  getMatrixRecoveryKeyHandler,
  getMatrixVerificationStore,
  registerMatrixRecoveryKeyHandler,
  registerMatrixVerificationStore,
  unregisterMatrixRecoveryKeyHandler,
} from "./registry.js";
import type { RecoveryKeyStore } from "./store.js";

// Minimal stubs — the registry only stores/retrieves references
const fakeHandler = { verifyWithRecoveryKey: () => {} } as unknown as RecoveryKeyHandler;
const fakeHandler2 = { verifyWithRecoveryKey: () => {} } as unknown as RecoveryKeyHandler;
const fakeStore = { getState: () => ({}) } as unknown as RecoveryKeyStore;

afterEach(() => {
  // Clean up all test registrations
  unregisterMatrixRecoveryKeyHandler("acct-a");
  unregisterMatrixRecoveryKeyHandler("acct-b");
  unregisterMatrixRecoveryKeyHandler(null);
  unregisterMatrixRecoveryKeyHandler(undefined);
});

describe("handler registry", () => {
  it("returns undefined for unregistered account", () => {
    expect(getMatrixRecoveryKeyHandler("nonexistent")).toBeUndefined();
  });

  it("registers and retrieves a handler", () => {
    registerMatrixRecoveryKeyHandler(fakeHandler, "acct-a");
    expect(getMatrixRecoveryKeyHandler("acct-a")).toBe(fakeHandler);
  });

  it("uses default key for null/undefined account", () => {
    registerMatrixRecoveryKeyHandler(fakeHandler, null);
    expect(getMatrixRecoveryKeyHandler(null)).toBe(fakeHandler);
    expect(getMatrixRecoveryKeyHandler(undefined)).toBe(fakeHandler);
    expect(getMatrixRecoveryKeyHandler("")).toBe(fakeHandler);
  });

  it("isolates different accounts", () => {
    registerMatrixRecoveryKeyHandler(fakeHandler, "acct-a");
    registerMatrixRecoveryKeyHandler(fakeHandler2, "acct-b");
    expect(getMatrixRecoveryKeyHandler("acct-a")).toBe(fakeHandler);
    expect(getMatrixRecoveryKeyHandler("acct-b")).toBe(fakeHandler2);
  });

  it("unregister removes the handler", () => {
    registerMatrixRecoveryKeyHandler(fakeHandler, "acct-a");
    unregisterMatrixRecoveryKeyHandler("acct-a");
    expect(getMatrixRecoveryKeyHandler("acct-a")).toBeUndefined();
  });
});

describe("store registry", () => {
  it("returns undefined for unregistered account", () => {
    expect(getMatrixVerificationStore("nonexistent")).toBeUndefined();
  });

  it("registers and retrieves a store", () => {
    registerMatrixVerificationStore(fakeStore, "acct-a");
    expect(getMatrixVerificationStore("acct-a")).toBe(fakeStore);
  });

  it("unregister removes both handler and store", () => {
    registerMatrixRecoveryKeyHandler(fakeHandler, "acct-a");
    registerMatrixVerificationStore(fakeStore, "acct-a");
    unregisterMatrixRecoveryKeyHandler("acct-a");
    expect(getMatrixRecoveryKeyHandler("acct-a")).toBeUndefined();
    expect(getMatrixVerificationStore("acct-a")).toBeUndefined();
  });
});
