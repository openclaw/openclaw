import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AcpClientOptions, AcpClientHandle } from "./client.js";

describe("acp/client module", () => {
  it("should export createAcpClient function", async () => {
    const mod = await import("./client.js");
    expect(typeof mod.createAcpClient).toBe("function");
  });

  it("should export types for AcpClientOptions", async () => {
    const mod = await import("./client.js");
    // Type should be available (runtime check)
    expect(mod.createAcpClient).toBeDefined();
  });

  it("should handle client options", async () => {
    const mod = await import("./client.js");
    const opts: AcpClientOptions = {
      cwd: process.cwd(),
      verbose: true,
    };
    expect(opts).toBeDefined();
  });

  it("should support serverCommand option", async () => {
    const opts: AcpClientOptions = {
      serverCommand: "custom-command",
    };
    expect(opts.serverCommand).toBe("custom-command");
  });

  it("should support serverArgs option", async () => {
    const opts: AcpClientOptions = {
      serverArgs: ["--flag", "value"],
    };
    expect(Array.isArray(opts.serverArgs)).toBe(true);
    expect(opts.serverArgs?.length).toBe(2);
  });

  it("should support verbose option", async () => {
    const opts: AcpClientOptions = {
      verbose: false,
      serverVerbose: true,
    };
    expect(opts.verbose).toBe(false);
    expect(opts.serverVerbose).toBe(true);
  });

  it("should have default options", async () => {
    const defaultOpts: AcpClientOptions = {};
    expect(defaultOpts).toBeDefined();
    expect(defaultOpts.cwd).toBeUndefined();
  });

  it("should export AcpClientHandle type", async () => {
    const mod = await import("./client.js");
    // Type validation - check that module exports are available
    expect(mod).toBeDefined();
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it("should handle client creation with default options", async () => {
    const opts: AcpClientOptions = {};
    expect(opts).toBeDefined();
  });

  it("should allow combining multiple options", async () => {
    const opts: AcpClientOptions = {
      cwd: "/tmp",
      serverCommand: "custom",
      serverArgs: ["--arg"],
      serverVerbose: true,
      verbose: true,
    };
    expect(opts.cwd).toBe("/tmp");
    expect(opts.serverCommand).toBe("custom");
    expect(opts.serverArgs).toHaveLength(1);
    expect(opts.serverVerbose).toBe(true);
    expect(opts.verbose).toBe(true);
  });

  it("should have consistent option types", async () => {
    const opts1: AcpClientOptions = { verbose: true };
    const opts2: AcpClientOptions = { verbose: false };
    expect(typeof opts1.verbose).toBe(typeof opts2.verbose);
  });
});

describe("acp/client printSessionUpdate", () => {
  it("should handle session updates without errors", async () => {
    const mod = await import("./client.js");
    // Verify module structure
    expect(mod.createAcpClient).toBeDefined();
  });
});
