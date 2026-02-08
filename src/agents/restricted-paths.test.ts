import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRestrictedPath, RestrictedPathError } from "./restricted-paths.js";

describe("VULN-201: restricted paths for hooks and sensitive directories", () => {
  const homedir = os.homedir();
  const configDir = path.join(homedir, ".openclaw");
  const workspaceDir = "/workspace";

  describe("isRestrictedPath", () => {
    describe("blocks workspace hooks directory", () => {
      it("blocks direct path to hooks directory", () => {
        expect(
          isRestrictedPath({
            filePath: path.join(workspaceDir, "hooks"),
            workspaceDir,
          }),
        ).toBe(true);
      });

      it("blocks hook handler files", () => {
        expect(
          isRestrictedPath({
            filePath: path.join(workspaceDir, "hooks", "backdoor", "handler.ts"),
            workspaceDir,
          }),
        ).toBe(true);
      });

      it("blocks hook.json metadata files", () => {
        expect(
          isRestrictedPath({
            filePath: path.join(workspaceDir, "hooks", "backdoor", "hook.json"),
            workspaceDir,
          }),
        ).toBe(true);
      });

      it("blocks nested paths within hooks", () => {
        expect(
          isRestrictedPath({
            filePath: path.join(workspaceDir, "hooks", "deep", "nested", "file.ts"),
            workspaceDir,
          }),
        ).toBe(true);
      });
    });

    describe("blocks managed hooks directory (~/.openclaw/hooks)", () => {
      it("blocks managed hooks directory", () => {
        expect(
          isRestrictedPath({
            filePath: path.join(configDir, "hooks", "test", "handler.ts"),
            workspaceDir,
          }),
        ).toBe(true);
      });

      it("blocks hook.json in managed hooks", () => {
        expect(
          isRestrictedPath({
            filePath: path.join(configDir, "hooks", "test", "hook.json"),
            workspaceDir,
          }),
        ).toBe(true);
      });
    });

    describe("blocks credentials directory", () => {
      it("blocks credentials directory", () => {
        expect(
          isRestrictedPath({
            filePath: path.join(configDir, "credentials", "oauth.json"),
            workspaceDir,
          }),
        ).toBe(true);
      });
    });

    describe("allows normal paths", () => {
      it("allows files in workspace root", () => {
        expect(
          isRestrictedPath({
            filePath: path.join(workspaceDir, "src", "index.ts"),
            workspaceDir,
          }),
        ).toBe(false);
      });

      it("allows files with 'hooks' in name but not in hooks directory", () => {
        expect(
          isRestrictedPath({
            filePath: path.join(workspaceDir, "src", "my-hooks-helper.ts"),
            workspaceDir,
          }),
        ).toBe(false);
      });

      it("allows files outside workspace", () => {
        expect(
          isRestrictedPath({
            filePath: "/tmp/test-file.ts",
            workspaceDir,
          }),
        ).toBe(false);
      });
    });

    describe("handles path traversal attempts", () => {
      it("blocks path traversal to hooks", () => {
        expect(
          isRestrictedPath({
            filePath: path.join(workspaceDir, "src", "..", "hooks", "backdoor", "handler.ts"),
            workspaceDir,
          }),
        ).toBe(true);
      });

      it("blocks path with multiple .. to reach hooks", () => {
        expect(
          isRestrictedPath({
            filePath: path.join(workspaceDir, "a", "b", "..", "..", "hooks", "test.ts"),
            workspaceDir,
          }),
        ).toBe(true);
      });
    });

    describe("handles tilde expansion", () => {
      it("blocks ~/.<config>/hooks paths", () => {
        expect(
          isRestrictedPath({
            filePath: "~/.openclaw/hooks/backdoor/handler.ts",
            workspaceDir,
          }),
        ).toBe(true);
      });

      it("blocks ~/.<config>/credentials paths", () => {
        expect(
          isRestrictedPath({
            filePath: "~/.openclaw/credentials/tokens.json",
            workspaceDir,
          }),
        ).toBe(true);
      });
    });
  });

  describe("RestrictedPathError", () => {
    it("has correct name", () => {
      const error = new RestrictedPathError("/path/to/hooks/handler.ts");
      expect(error.name).toBe("RestrictedPathError");
    });

    it("includes path in message", () => {
      const error = new RestrictedPathError("/path/to/hooks/handler.ts");
      expect(error.message).toContain("hooks");
    });
  });
});
