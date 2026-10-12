import fs from "node:fs";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractSections } from "../../auto-reply/reply/post-compaction-context.js";
import { openRootFile } from "../../infra/boundary-file-read.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readWorkspaceBootstrapFile } from "../workspace-bootstrap-read.js";

const log = createSubsystemLogger("compaction-safeguard");

export async function readWorkspaceContextForSummary(
  sectionNames: string[] | undefined,
  workspaceDir: string | undefined,
): Promise<string> {
  const MAX_SUMMARY_CONTEXT_CHARS = 2000;
  if (!Array.isArray(sectionNames) || sectionNames.length === 0) {
    return "";
  }
  if (!workspaceDir) {
    log.warn("Compaction safeguard: workspace rules skipped; no agent workspace was provided.");
    return "";
  }
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    const opened = await openRootFile({
      absolutePath: agentsPath,
      rootPath: workspaceDir,
      boundaryLabel: "workspace root",
    });
    if (!opened.ok) {
      log.warn(
        `Compaction safeguard: cannot open ${agentsPath} (${opened.reason}); workspace rules skipped.`,
      );
      return "";
    }

    let content: string;
    try {
      content = await readWorkspaceBootstrapFile(opened.fd);
    } finally {
      fs.closeSync(opened.fd);
    }
    let sections = extractSections(content, sectionNames);
    // Shipped default headings retain their legacy fallback.
    if (
      sections.length === 0 &&
      sectionNames.length === 2 &&
      sectionNames.some((name) => name.trim().toLowerCase() === "session startup") &&
      sectionNames.some((name) => name.trim().toLowerCase() === "red lines")
    ) {
      sections = extractSections(content, ["Every Session", "Safety"]);
    }
    if (sections.length < sectionNames.length) {
      log.warn(
        `Compaction safeguard: found ${sections.length} of ${sectionNames.length} configured sections in ${agentsPath}; check postCompactionSections.`,
      );
    }
    if (sections.length === 0) {
      return "";
    }

    const combined = sections.join("\n\n");
    const safeContent =
      combined.length > MAX_SUMMARY_CONTEXT_CHARS
        ? `${truncateUtf16Safe(combined, MAX_SUMMARY_CONTEXT_CHARS)}\n...[truncated]...`
        : combined;

    return `\n\n<workspace-critical-rules>\n${safeContent}\n</workspace-critical-rules>`;
  } catch (err) {
    log.warn(
      `Compaction safeguard: cannot read ${agentsPath}; workspace rules skipped: ${formatErrorMessage(err)}`,
    );
    return "";
  }
}
