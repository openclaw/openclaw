/**
 * Unit tests for device-auth module
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  loadDeviceAuthToken,
  storeDeviceAuthToken,
  clearDeviceAuthToken,
  buildDeviceAuthPayload,
} from "./device-auth";

const STORAGE_KEY = "clawdbrain.device.auth.v1";

describe("device-auth", () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  describe("buildDeviceAuthPayload", () => {
    it("builds v1 payload without nonce", () => {
      const payload = buildDeviceAuthPayload({
        deviceId: "device-123",
        clientId: "test-client",
        clientMode: "webchat",
        role: "operator",
        scopes: ["scope1", "scope2"],
        signedAtMs: 1234567890,
        token: "token-abc",
      });

      expect(payload).toBe("v1|device-123|test-client|webchat|operator|scope1,scope2|1234567890|token-abc");
    });

    it("builds v2 payload with nonce", () => {
      const payload = buildDeviceAuthPayload({
        deviceId: "device-123",
        clientId: "test-client",
        clientMode: "webchat",
        role: "operator",
        scopes: ["scope1", "scope2"],
        signedAtMs: 1234567890,
        token: "token-abc",
        nonce: "nonce-xyz",
      });

      expect(payload).toBe(
        "v2|device-123|test-client|webchat|operator|scope1,scope2|1234567890|token-abc|nonce-xyz"
      );
    });

    it("handles empty token", () => {
      const payload = buildDeviceAuthPayload({
        deviceId: "device-123",
        clientId: "test-client",
        clientMode: "webchat",
        role: "operator",
        scopes: [],
        signedAtMs: 1234567890,
      });

      expect(payload).toBe("v1|device-123|test-client|webchat|operator||1234567890|");
    });

    it("allows forcing v1 with nonce", () => {
      const payload = buildDeviceAuthPayload({
        deviceId: "device-123",
        clientId: "test-client",
        clientMode: "webchat",
        role: "operator",
        scopes: [],
        signedAtMs: 1234567890,
        nonce: "nonce-xyz",
        version: "v1",
      });

      // v1 doesn't include nonce in payload
      expect(payload).toBe("v1|device-123|test-client|webchat|operator||1234567890|");
    });
  });

  describe("storeDeviceAuthToken", () => {
    it("stores a token for a device and role", () => {
      const entry = storeDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
        token: "token-abc",
        scopes: ["scope1", "scope2"],
      });

      expect(entry.token).toBe("token-abc");
      expect(entry.role).toBe("operator");
      expect(entry.scopes).toEqual(["scope1", "scope2"]);
      expect(entry.updatedAtMs).toBeGreaterThan(0);

      // Verify it's in localStorage
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).toBeTruthy();
      const stored = JSON.parse(raw!);
      expect(stored.deviceId).toBe("device-123");
      expect(stored.tokens.operator.token).toBe("token-abc");
    });

    it("normalizes scopes", () => {
      const entry = storeDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
        token: "token-abc",
        scopes: ["  scope2 ", "scope1", "scope1"], // duplicates and whitespace
      });

      expect(entry.scopes).toEqual(["scope1", "scope2"]); // sorted, deduped, trimmed
    });

    it("preserves tokens for other roles", () => {
      storeDeviceAuthToken({
        deviceId: "device-123",
        role: "admin",
        token: "admin-token",
      });

      storeDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
        token: "operator-token",
      });

      const raw = localStorage.getItem(STORAGE_KEY);
      const stored = JSON.parse(raw!);
      expect(stored.tokens.admin.token).toBe("admin-token");
      expect(stored.tokens.operator.token).toBe("operator-token");
    });

    it("clears tokens for different device", () => {
      storeDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
        token: "token-1",
      });

      storeDeviceAuthToken({
        deviceId: "device-456", // different device
        role: "operator",
        token: "token-2",
      });

      const raw = localStorage.getItem(STORAGE_KEY);
      const stored = JSON.parse(raw!);
      expect(stored.deviceId).toBe("device-456");
      expect(stored.tokens.operator.token).toBe("token-2");
      // Old device's tokens should be gone
      expect(Object.keys(stored.tokens)).toEqual(["operator"]);
    });
  });

  describe("loadDeviceAuthToken", () => {
    it("returns null when no store exists", () => {
      const entry = loadDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
      });

      expect(entry).toBeNull();
    });

    it("returns null for wrong device", () => {
      storeDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
        token: "token-abc",
      });

      const entry = loadDeviceAuthToken({
        deviceId: "device-456",
        role: "operator",
      });

      expect(entry).toBeNull();
    });

    it("returns null for missing role", () => {
      storeDeviceAuthToken({
        deviceId: "device-123",
        role: "admin",
        token: "token-abc",
      });

      const entry = loadDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
      });

      expect(entry).toBeNull();
    });

    it("returns entry for matching device and role", () => {
      storeDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
        token: "token-abc",
        scopes: ["scope1"],
      });

      const entry = loadDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
      });

      expect(entry).toBeTruthy();
      expect(entry!.token).toBe("token-abc");
      expect(entry!.scopes).toEqual(["scope1"]);
    });
  });

  describe("clearDeviceAuthToken", () => {
    it("clears a specific role token", () => {
      storeDeviceAuthToken({
        deviceId: "device-123",
        role: "admin",
        token: "admin-token",
      });

      storeDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
        token: "operator-token",
      });

      clearDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
      });

      const operatorEntry = loadDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
      });
      expect(operatorEntry).toBeNull();

      const adminEntry = loadDeviceAuthToken({
        deviceId: "device-123",
        role: "admin",
      });
      expect(adminEntry).toBeTruthy();
    });

    it("does nothing for wrong device", () => {
      storeDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
        token: "token-abc",
      });

      clearDeviceAuthToken({
        deviceId: "device-456",
        role: "operator",
      });

      const entry = loadDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
      });
      expect(entry).toBeTruthy();
    });

    it("does nothing for missing role", () => {
      storeDeviceAuthToken({
        deviceId: "device-123",
        role: "admin",
        token: "token-abc",
      });

      clearDeviceAuthToken({
        deviceId: "device-123",
        role: "operator",
      });

      const entry = loadDeviceAuthToken({
        deviceId: "device-123",
        role: "admin",
      });
      expect(entry).toBeTruthy();
    });
  });
});
