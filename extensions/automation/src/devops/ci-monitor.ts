export interface CIStatus {
  provider: "github-actions" | "gitlab-ci" | "other";
  repo: string;
  branch: string;
  status: "success" | "failure" | "pending" | "running";
  url: string;
  updatedAt: number;
}

export function formatCIStatusBoard(statuses: CIStatus[]): string {
  if (statuses.length === 0) return "<b>🏗️ CI/CD Status Board</b>\n\nNo active checks.";

  const lines = ["<b>🏗️ CI/CD Status Board</b>\n"];
  for (const s of statuses) {
    const emoji =
      s.status === "success"
        ? "✅"
        : s.status === "failure"
          ? "❌"
          : s.status === "running"
            ? "🔄"
            : "⏳";
    const age = Math.round((Date.now() - s.updatedAt) / 60000);
    lines.push(`${emoji} <code>${s.repo}</code> / ${s.branch} — ${age}m ago`);
  }
  return lines.join("\n");
}
