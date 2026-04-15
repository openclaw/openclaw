import { describe, expect, it } from "vitest";
import {
  classifyFsPermissionDeniedReason,
  createFsPermissionDeniedError,
} from "./fs-permission-denied.js";

describe("fs-permission-denied", () => {
  it("classifies workspace boundary violations", () => {
    expect(
      classifyFsPermissionDeniedReason(new Error("Path escapes sandbox root (/tmp/workspace): ../x")),
    ).toBe("workspace_boundary");
    expect(
      classifyFsPermissionDeniedReason(new Error("file is outside workspace root")),
    ).toBe("workspace_boundary");
  });

  it("classifies symlink/hardlink violations as path alias escapes", () => {
    expect(
      classifyFsPermissionDeniedReason(new Error("Symlink escapes sandbox root")),
    ).toBe("path_alias_escape");
    expect(
      classifyFsPermissionDeniedReason(new Error("hardlinked path not allowed")),
    ).toBe("path_alias_escape");
  });

  it("classifies read-only filesystem violations", () => {
    expect(
      classifyFsPermissionDeniedReason(new Error("Sandbox path is read-only; cannot write")),
    ).toBe("readonly_filesystem");
  });

  it("creates standardized permission_denied error payload", () => {
    const error = createFsPermissionDeniedError({
      action: "apply_patch:path_guard",
      path: "../secrets.txt",
      cause: new Error("Path escapes sandbox root"),
    }) as Error & { code?: string; reason?: string };

    expect(error.code).toBe("E_FS_PERMISSION_DENIED");
    expect(error.reason).toBe("workspace_boundary");
    expect(error.message).toContain("permission_denied");
    expect(error.message).toContain("action=apply_patch:path_guard");
    expect(error.message).toContain("reason=workspace_boundary");
  });
});

