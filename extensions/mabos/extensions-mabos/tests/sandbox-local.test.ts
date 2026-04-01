import { describe, it, assert } from "vitest";
import { LocalBackend } from "../src/execution-sandbox/backends/local.js";
import { SandboxManager } from "../src/execution-sandbox/manager.js";

describe("LocalBackend", () => {
  const backend = new LocalBackend();

  it("executes simple command", async () => {
    const result = await backend.exec("echo hello");
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("hello"));
    assert.equal(result.backend, "local");
  });

  it("captures exit code on failure", async () => {
    const result = await backend.exec("exit 42");
    assert.equal(result.exitCode, 42);
  });

  it("respects timeout", async () => {
    const result = await backend.exec("sleep 10", { timeoutMs: 500 });
    assert.ok(result.exitCode !== 0 || result.stderr.length > 0 || result.durationMs < 10000);
  });

  it("captures stderr", async () => {
    const result = await backend.exec("echo error >&2");
    assert.ok(result.stderr.includes("error"));
  });

  it("is always healthy", async () => {
    assert.equal(await backend.isHealthy(), true);
  });
});

describe("SandboxManager", () => {
  it("creates and manages local sandboxes", async () => {
    const manager = new SandboxManager({ defaultBackend: "local" });
    const sandbox = await manager.getOrCreate("test-task");
    assert.equal(sandbox.name, "local");

    const active = manager.getActiveSandboxes();
    assert.equal(active.length, 1);
    assert.equal(active[0].taskId, "test-task");

    await manager.destroyAll();
    assert.equal(manager.getActiveSandboxes().length, 0);
  });

  it("reuses existing sandbox for same taskId", async () => {
    const manager = new SandboxManager({ defaultBackend: "local" });
    const s1 = await manager.getOrCreate("task-1");
    const s2 = await manager.getOrCreate("task-1");
    assert.equal(s1, s2);
    await manager.destroyAll();
  });

  it("resolves per-agent backend", () => {
    const manager = new SandboxManager({
      defaultBackend: "local",
      perAgent: { "cto-agent": { backend: "docker" } },
    });
    assert.equal(manager.resolveBackend("cto-agent"), "docker");
    assert.equal(manager.resolveBackend("ceo-agent"), "local");
  });
});
