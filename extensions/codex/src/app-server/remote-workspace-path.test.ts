import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapCodexAppServerLocalWorkspacePath,
  mapCodexAppServerRemoteWorkspacePath,
} from "./remote-workspace-path.js";

const localWorkspaceRoot = path.resolve("gateway-workspace");
const remoteWorkspaceRoot = "/remote/codex-workspace";
const roots = { localWorkspaceRoot, remoteWorkspaceRoot };
const localPath = (value: string, overrides: Partial<typeof roots> = {}) =>
  mapCodexAppServerLocalWorkspacePath({ ...roots, ...overrides, value });
const remotePath = (value: string, overrides: Partial<typeof roots> = {}) =>
  mapCodexAppServerRemoteWorkspacePath({ ...roots, ...overrides, value });

describe("Codex remote workspace paths", () => {
  it.each([
    [
      () => remotePath("/reports/slack-upload.txt", { localWorkspaceRoot: "/" }),
      `${remoteWorkspaceRoot}/reports/slack-upload.txt`,
    ],
    [
      () => localPath("c:\\Reports\\Upload.TXT", { remoteWorkspaceRoot: "C:\\" }),
      path.join(localWorkspaceRoot, "Reports", "Upload.TXT"),
    ],
    [
      () =>
        remotePath(path.join(localWorkspaceRoot, "reports", "upload.txt"), {
          remoteWorkspaceRoot: "C:\\",
        }),
      "C:/reports/upload.txt",
    ],
  ] as const)("maps workspace path %#", (resolve, expected) => {
    expect(resolve()).toBe(expected);
  });

  it("preserves URL-backed and managed media sources", () => {
    for (const value of [
      "https://example.com/image.png",
      "mxc://example.org/image",
      "buffer://generated-image",
      "media://inbound/image.png",
      "data:image/png;base64,aGVsbG8=",
    ]) {
      expect(localPath(value)).toBe(value);
    }
  });

  it("normalizes harmless relative and nested dot segments", () => {
    for (const value of [
      "./reports/slack-upload.txt",
      "reports/./slack-upload.txt",
      `${remoteWorkspaceRoot}/reports/./slack-upload.txt`,
    ]) {
      expect(localPath(value)).toBe(path.join(localWorkspaceRoot, "reports", "slack-upload.txt"));
    }
  });

  it.each([
    [["c:\\work\\repo-other\\private.txt"], "C:\\Work\\Repo", "outside"],
    [
      [
        `${remoteWorkspaceRoot}-other/report.txt`,
        "/etc/passwd",
        path.join(localWorkspaceRoot, "private.txt"),
        "file:///etc/passwd",
      ],
      remoteWorkspaceRoot,
      "outside",
    ],
    [[`${remoteWorkspaceRoot}/reports/../../private.txt`], remoteWorkspaceRoot, "must stay inside"],
  ] as const)("rejects %j", (values, root, error) => {
    for (const value of values) {
      expect(() => localPath(value, { remoteWorkspaceRoot: root })).toThrow(error);
    }
  });

  it("preserves workspace paths when no remote root is configured", () => {
    const value = path.join(localWorkspaceRoot, "report.txt");
    expect(mapCodexAppServerRemoteWorkspacePath({ value, localWorkspaceRoot })).toBe(value);
    expect(mapCodexAppServerLocalWorkspacePath({ value, localWorkspaceRoot })).toBe(value);
  });

  it("continues rejecting gateway working directories outside the workspace", () => {
    expect(() => remotePath(path.resolve("outside-workspace", "report.txt"))).toThrow(
      "outside OpenClaw workspace root",
    );
  });
});
