/**
 * Diff Extension
 *
 * /diff command shows modified/deleted/new files from git status and opens
 * the selected file in VS Code's diff view.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { showPagedSelectList } from "./ui/paged-select";

interface FileInfo {
  status: string;
  statusLabel: string;
  file: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Show git changes and open in VS Code diff view",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("No UI available", "error");
        return;
      }

      // Get changed files from git status
      const result = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });

      if (result.code !== 0) {
        ctx.ui.notify(`git status failed: ${result.stderr}`, "error");
        return;
      }

      if (!result.stdout || !result.stdout.trim()) {
        ctx.ui.notify("No changes in working tree", "info");
        return;
      }

      // Parse git status output
      // Format: XY filename (where XY is two-letter status, then space, then filename)
      const lines = result.stdout.split("\n");
      const files: FileInfo[] = [];

      for (const line of lines) {
        if (line.length < 4) {
          continue;
        } // Need at least "XY f"

        const status = line.slice(0, 2);
        const file = line.slice(2).trimStart();

        // Translate status codes to short labels
        let statusLabel: string;
        if (status.includes("M")) {
          statusLabel = "M";
        } else if (status.includes("A")) {
          statusLabel = "A";
        } else if (status.includes("D")) {
          statusLabel = "D";
        } else if (status.includes("?")) {
          statusLabel = "?";
        } else if (status.includes("R")) {
          statusLabel = "R";
        } else if (status.includes("C")) {
          statusLabel = "C";
        } else {
          statusLabel = status.trim() || "~";
        }

        files.push({ status: statusLabel, statusLabel, file });
      }

      if (files.length === 0) {
        ctx.ui.notify("No changes found", "info");
        return;
      }

      const openSelected = async (fileInfo: FileInfo): Promise<void> => {
        try {
          // Open in VS Code diff view.
          // For untracked files, git difftool won't work, so fall back to just opening the file.
          if (fileInfo.status === "?") {
            await pi.exec("code", ["-g", fileInfo.file], { cwd: ctx.cwd });
            return;
          }

          const diffResult = await pi.exec(
            "git",
            ["difftool", "-y", "--tool=vscode", fileInfo.file],
            {
              cwd: ctx.cwd,
            },
          );
          if (diffResult.code !== 0) {
            await pi.exec("code", ["-g", fileInfo.file], { cwd: ctx.cwd });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to open ${fileInfo.file}: ${message}`, "error");
        }
      };

      const items = files.map((file) => ({
        value: file,
        label: `${file.status} ${file.file}`,
      }));
      await showPagedSelectList({
        ctx,
        title: " Select file to diff",
        items,
        onSelect: (item) => {
          void openSelected(item.value as FileInfo);
        },
      });
    },
  });
}
