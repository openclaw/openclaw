import { describe, expect, it } from "vitest";
import { buildDockerExecArgs } from "./bash-tools.shared.js";

describe("buildDockerExecArgs", () => {
  const base = {
    containerName: "test-container",
    command: "echo hello",
    env: {} as Record<string, string>,
    tty: false,
  };

  it("produces basic exec args without user", () => {
    const args = buildDockerExecArgs(base);
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("-i");
    // No -u flag
    expect(args).not.toContain("-u");
    expect(args).toContain("test-container");
  });

  it("inserts -u flag when user is provided", () => {
    const args = buildDockerExecArgs({ ...base, user: "1000:1000" });
    const uIndex = args.indexOf("-u");
    expect(uIndex).toBeGreaterThan(0);
    expect(args[uIndex + 1]).toBe("1000:1000");
    // -u should come before the container name
    const containerIndex = args.indexOf("test-container");
    expect(uIndex).toBeLessThan(containerIndex);
  });

  it("does not insert -u flag when user is undefined", () => {
    const args = buildDockerExecArgs({ ...base, user: undefined });
    expect(args).not.toContain("-u");
  });

  it("does not insert -u flag when user is empty string", () => {
    const args = buildDockerExecArgs({ ...base, user: "" });
    expect(args).not.toContain("-u");
  });

  it("places -u before -t when both user and tty are set", () => {
    const args = buildDockerExecArgs({ ...base, user: "1000:1000", tty: true });
    const uIndex = args.indexOf("-u");
    const tIndex = args.indexOf("-t");
    expect(uIndex).toBeGreaterThan(0);
    expect(tIndex).toBeGreaterThan(0);
    expect(uIndex).toBeLessThan(tIndex);
  });

  it("places -u before workdir flag", () => {
    const args = buildDockerExecArgs({
      ...base,
      user: "1000:1000",
      workdir: "/workspace",
    });
    const uIndex = args.indexOf("-u");
    const wIndex = args.indexOf("-w");
    expect(uIndex).toBeLessThan(wIndex);
  });
});
