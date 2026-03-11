import { describe, expect, it } from "vitest";
import { resolveFilesystemPermissions } from "../infra/filesystem-permissions.js";
import { __testing, assertExecFilesystemPermissions } from "./bash-tools.exec-fs-permissions.js";

describe("exec filesystem permissions", () => {
  it("extracts read/write checks from cp and rm operands", () => {
    const { checks, analysis } = __testing.collectExecPathPermissionChecks({
      command: "cp ./src.txt ./dest.txt && rm ./dest.txt",
      cwd: "/workspace",
      env: {},
    });
    expect(analysis.ok).toBe(true);
    const summary = checks.map((entry) => ({
      op: entry.operation,
      reason: entry.reason,
      path: entry.targetPath,
    }));
    expect(summary).toContainEqual({
      op: "read",
      reason: "cp source",
      path: "/workspace/src.txt",
    });
    expect(summary).toContainEqual({
      op: "write",
      reason: "cp destination",
      path: "/workspace/dest.txt",
    });
    expect(summary).toContainEqual({
      op: "write",
      reason: "rm operand",
      path: "/workspace/dest.txt",
    });
  });

  it("blocks exec when a referenced path lacks required permission", () => {
    const permissions = resolveFilesystemPermissions({
      rules: {
        "/workspace/**": "rw-",
        "/bin/**": "r-x",
      },
      default: "---",
    });
    expect(permissions).toBeDefined();

    expect(() =>
      assertExecFilesystemPermissions({
        command: "cat /etc/passwd",
        cwd: "/workspace",
        env: {},
        permissions,
      }),
    ).toThrow(/filesystem permission denied \(r\)/);
  });

  it("allows exec when executable and operands are permitted", () => {
    const permissions = resolveFilesystemPermissions({
      rules: {
        "/workspace/**": "rw-",
        "/bin/**": "r-x",
      },
      default: "---",
    });
    expect(permissions).toBeDefined();

    expect(() =>
      assertExecFilesystemPermissions({
        command: "/bin/cat /workspace/file.txt",
        cwd: "/workspace",
        env: {},
        permissions,
      }),
    ).not.toThrow();
  });
});
