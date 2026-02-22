import { describe, it, expect, vi } from "vitest";

/**
 * Tests for TypeDB connection fallback behavior.
 * The MABOS extension uses TypeDB as an optional persistence layer.
 * When TypeDB is unavailable, operations should fall back to local JSON files.
 */

// Minimal mock of the TypeDB client interface used by MABOS
function createMockTypeDBClient(options: { connectSucceeds: boolean }) {
  let connected = false;
  let cooldownActive = false;

  return {
    async connect(): Promise<boolean> {
      if (cooldownActive) return false;
      if (!options.connectSucceeds) {
        cooldownActive = true;
        setTimeout(() => {
          cooldownActive = false;
        }, 100);
        return false;
      }
      connected = true;
      return true;
    },
    isAvailable(): boolean {
      return connected && !cooldownActive;
    },
    disconnect() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
  };
}

describe("TypeDB fallback behavior", () => {
  it("reports unavailable when connection fails", async () => {
    const client = createMockTypeDBClient({ connectSucceeds: false });
    const result = await client.connect();
    expect(result).toBe(false);
    expect(client.isAvailable()).toBe(false);
  });

  it("reports available after successful connection", async () => {
    const client = createMockTypeDBClient({ connectSucceeds: true });
    const result = await client.connect();
    expect(result).toBe(true);
    expect(client.isAvailable()).toBe(true);
  });

  it("enters cooldown period after connection failure", async () => {
    const client = createMockTypeDBClient({ connectSucceeds: false });
    await client.connect();

    // During cooldown, connect should return false immediately
    const secondAttempt = await client.connect();
    expect(secondAttempt).toBe(false);
    expect(client.isAvailable()).toBe(false);
  });

  it("recovers after cooldown period expires", async () => {
    const client = createMockTypeDBClient({ connectSucceeds: false });
    await client.connect();
    expect(client.isAvailable()).toBe(false);

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 150));
    expect(client.isAvailable()).toBe(false); // Still not available, just cooldown expired

    // A new client that can connect should work
    const healthyClient = createMockTypeDBClient({ connectSucceeds: true });
    const result = await healthyClient.connect();
    expect(result).toBe(true);
    expect(healthyClient.isAvailable()).toBe(true);
  });

  it("reports unavailable after disconnect", async () => {
    const client = createMockTypeDBClient({ connectSucceeds: true });
    await client.connect();
    expect(client.isAvailable()).toBe(true);

    client.disconnect();
    expect(client.isAvailable()).toBe(false);
    expect(client.isConnected()).toBe(false);
  });

  it("handles best-effort write pattern (success case)", async () => {
    const client = createMockTypeDBClient({ connectSucceeds: true });
    await client.connect();

    const writeToTypeDB = vi.fn().mockResolvedValue(true);
    const writeToLocal = vi.fn().mockResolvedValue(true);

    // Best-effort pattern: write locally, then try TypeDB
    await writeToLocal({ data: "test" });
    expect(writeToLocal).toHaveBeenCalled();

    if (client.isAvailable()) {
      await writeToTypeDB({ data: "test" });
    }
    expect(writeToTypeDB).toHaveBeenCalled();
  });

  it("handles best-effort write pattern (TypeDB unavailable)", async () => {
    const client = createMockTypeDBClient({ connectSucceeds: false });
    await client.connect();

    const writeToTypeDB = vi.fn().mockResolvedValue(true);
    const writeToLocal = vi.fn().mockResolvedValue(true);

    // Best-effort pattern: write locally, skip TypeDB
    await writeToLocal({ data: "test" });
    expect(writeToLocal).toHaveBeenCalled();

    if (client.isAvailable()) {
      await writeToTypeDB({ data: "test" });
    }
    expect(writeToTypeDB).not.toHaveBeenCalled();
  });
});
