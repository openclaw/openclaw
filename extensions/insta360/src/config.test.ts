import { describe, expect, it } from "vitest";
import { parseInsta360Config } from "./config.js";

describe("parseInsta360Config", () => {
  it("returns defaults when no config provided", () => {
    const config = parseInsta360Config(undefined);
    expect(config.cameraHost).toBe("http://192.168.42.1");
    expect(config.downloadPath).toBe("");
    expect(config.lowBatteryThreshold).toBe(15);
    expect(config.lowStorageMB).toBe(500);
    expect(config.pollIntervalMs).toBe(30000);
  });

  it("returns defaults when empty object provided", () => {
    const config = parseInsta360Config({});
    expect(config.cameraHost).toBe("http://192.168.42.1");
    expect(config.downloadPath).toBe("");
    expect(config.lowBatteryThreshold).toBe(15);
    expect(config.lowStorageMB).toBe(500);
    expect(config.pollIntervalMs).toBe(30000);
  });

  it("parses valid config", () => {
    const config = parseInsta360Config({
      cameraHost: "http://192.168.1.100",
      downloadPath: "/tmp/insta360",
      lowBatteryThreshold: 20,
      lowStorageMB: 1000,
      pollIntervalMs: 60000,
    });
    expect(config.cameraHost).toBe("http://192.168.1.100");
    expect(config.downloadPath).toBe("/tmp/insta360");
    expect(config.lowBatteryThreshold).toBe(20);
    expect(config.lowStorageMB).toBe(1000);
    expect(config.pollIntervalMs).toBe(60000);
  });

  it("clamps pollIntervalMs minimum to 5000", () => {
    const config = parseInsta360Config({ pollIntervalMs: 100 });
    expect(config.pollIntervalMs).toBe(5000);
  });

  it("keeps pollIntervalMs at exactly 5000 when set to 5000", () => {
    const config = parseInsta360Config({ pollIntervalMs: 5000 });
    expect(config.pollIntervalMs).toBe(5000);
  });

  it("clamps lowBatteryThreshold to minimum 1", () => {
    const config = parseInsta360Config({ lowBatteryThreshold: 0 });
    expect(config.lowBatteryThreshold).toBe(1);
  });

  it("clamps lowBatteryThreshold to maximum 100", () => {
    const config = parseInsta360Config({ lowBatteryThreshold: 150 });
    expect(config.lowBatteryThreshold).toBe(100);
  });

  it("rejects non-http cameraHost (ftp://evil.com)", () => {
    expect(() => parseInsta360Config({ cameraHost: "ftp://evil.com" })).toThrow();
  });

  it("rejects public IP cameraHost (http://8.8.8.8)", () => {
    expect(() => parseInsta360Config({ cameraHost: "http://8.8.8.8" })).toThrow();
  });

  it("accepts 192.168.x.x private IP range", () => {
    const config = parseInsta360Config({ cameraHost: "http://192.168.0.1" });
    expect(config.cameraHost).toBe("http://192.168.0.1");
  });

  it("accepts 10.x.x.x private IP range", () => {
    const config = parseInsta360Config({ cameraHost: "http://10.0.0.1" });
    expect(config.cameraHost).toBe("http://10.0.0.1");
  });

  it("accepts 172.16.x.x private IP range", () => {
    const config = parseInsta360Config({ cameraHost: "http://172.16.0.1" });
    expect(config.cameraHost).toBe("http://172.16.0.1");
  });

  it("accepts 172.31.x.x private IP range", () => {
    const config = parseInsta360Config({ cameraHost: "http://172.31.255.255" });
    expect(config.cameraHost).toBe("http://172.31.255.255");
  });

  it("accepts localhost", () => {
    const config = parseInsta360Config({ cameraHost: "http://localhost" });
    expect(config.cameraHost).toBe("http://localhost");
  });

  it("accepts 127.0.0.1 loopback", () => {
    const config = parseInsta360Config({ cameraHost: "http://127.0.0.1" });
    expect(config.cameraHost).toBe("http://127.0.0.1");
  });

  it("normalizes cameraHost with trailing path to origin only", () => {
    const config = parseInsta360Config({ cameraHost: "http://192.168.42.1/osc/extra" });
    expect(config.cameraHost).toBe("http://192.168.42.1");
  });

  it("normalizes cameraHost with port to origin", () => {
    const config = parseInsta360Config({ cameraHost: "http://192.168.42.1:8080" });
    expect(config.cameraHost).toBe("http://192.168.42.1:8080");
  });

  it("rejects 172.32.x.x (outside 172.16-31 range)", () => {
    expect(() => parseInsta360Config({ cameraHost: "http://172.32.0.1" })).toThrow();
  });

  it("rejects lowStorageMB <= 0", () => {
    expect(() => parseInsta360Config({ lowStorageMB: 0 })).toThrow();
  });

  it("rejects negative lowStorageMB", () => {
    expect(() => parseInsta360Config({ lowStorageMB: -100 })).toThrow();
  });
});
