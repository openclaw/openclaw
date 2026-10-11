import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CreateReservedSandboxBackendParamsV1 } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { resolveMounts, validateRootfs } from "./filesystem.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function params(workspaceAccess: "none" | "ro" | "rw") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-run-mounts-"));
  directories.push(dir);
  const workspaceDir = path.join(dir, "private");
  const agentWorkspaceDir = path.join(dir, "agent");
  await fs.mkdir(workspaceDir);
  await fs.mkdir(agentWorkspaceDir);
  return {
    workspaceDir,
    agentWorkspaceDir,
    assertRuntimeCurrent() {},
    cfg: { workspaceAccess, docker: {} },
  } as CreateReservedSandboxBackendParamsV1;
}
describe("Cloud Run filesystem selection", () => {
  it("requires a dedicated root and keeps egress off", () => {
    expect(() => resolveConfig({ rootfs: "/" })).toThrow();
    expect(() => resolveConfig({ rootfs: "/opt/.." })).toThrow();
    expect(() => resolveConfig({ rootfs: "relative" })).toThrow();
    expect(resolveConfig({ rootfs: "/opt/guest" }).allowEgress).toBe(false);
  });
  it("rejects the live host root", async () => {
    await expect(validateRootfs("/", os.tmpdir())).rejects.toThrow("separate");
  });
  it("does not expose the agent workspace for none", async () => {
    const p = await params("none");
    const mounts = await resolveMounts(p, "/opt/guest");
    expect(mounts).toEqual([
      { hostPath: p.workspaceDir, containerPath: "/workspace", readOnly: false },
    ]);
  });
  it("makes both selected and agent workspace mounts readonly for ro", async () => {
    const p = await params("ro");
    const mounts = await resolveMounts(p, "/opt/guest");
    expect(mounts.map(({ containerPath, readOnly }) => ({ containerPath, readOnly }))).toEqual([
      { containerPath: "/workspace", readOnly: true },
      { containerPath: "/agent", readOnly: true },
    ]);
  });
  it("rejects nested instruction sources exposed through writable workspaces", async () => {
    const p = await params("none");
    await fs.mkdir(path.join(p.workspaceDir, "skills"));
    await expect(resolveMounts(p, "/opt/guest")).rejects.toThrow("disjoint");
  });
  it("rejects a writable source exposed through another writable mount", async () => {
    const p = await params("rw");
    p.agentWorkspaceDir = path.join(p.workspaceDir, "sub");
    await fs.mkdir(p.agentWorkspaceDir);
    await expect(resolveMounts(p, "/opt/guest")).rejects.toThrow("disjoint");
  });
  it("rejects read-only resources with a writable alias", async () => {
    const p = await params("rw");
    const resource = path.join(p.workspaceDir, "resource");
    await fs.mkdir(resource);
    p.readOnlyResourceMounts = [{ hostPath: resource, containerPath: "/agent/instructions" }];
    await expect(resolveMounts(p, "/opt/guest")).rejects.toThrow("disjoint");
  });
  it("accepts disjoint read-only resource sources", async () => {
    const p = await params("none");
    p.readOnlyResourceMounts = [
      { hostPath: p.agentWorkspaceDir, containerPath: "/workspace/instructions" },
    ];
    const mounts = await resolveMounts(p, "/opt/guest");
    expect(mounts.at(-1)?.readOnly).toBe(true);
  });
  it("rejects mount-field injection", async () => {
    const p = await params("none");
    const malicious = p.workspaceDir + ",readonly";
    await fs.mkdir(malicious);
    p.workspaceDir = malicious;
    await expect(resolveMounts(p, "/opt/guest")).rejects.toThrow("safely");
  });
  it("rejects rootfs overlapping a workspace", async () => {
    const p = await params("none");
    await expect(resolveMounts(p, p.workspaceDir)).rejects.toThrow("overlap");
  });
  it("rechecks authority after asynchronous path work", async () => {
    const p = await params("none");
    p.assertRuntimeCurrent = () => {
      throw new Error("revoked");
    };
    await expect(resolveMounts(p, "/opt/guest")).rejects.toThrow("revoked");
  });
});
