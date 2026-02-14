import { OpenClawSchema } from "@openclaw/config/zod-schema.ts";
import type { ConfigDraft } from "./config-store.ts";

export type ValidationIssue = {
  path: string;
  section: string;
  message: string;
};

export type ValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
  issuesByPath: Record<string, string[]>;
  sectionErrorCounts: Record<string, number>;
};

function issuePath(path: Array<string | number>): string {
  if (path.length === 0) {
    return "";
  }
  return path
    .map((segment) => (typeof segment === "number" ? String(segment) : segment))
    .join(".");
}

function issueSection(path: string): string {
  if (!path) {
    return "root";
  }
  const [section] = path.split(".");
  return section?.trim() || "root";
}

export function validateConfigDraft(config: ConfigDraft): ValidationResult {
  const parsed = OpenClawSchema.safeParse(config);
  if (parsed.success) {
    return {
      valid: true,
      issues: [],
      issuesByPath: {},
      sectionErrorCounts: {},
    };
  }

  const issues: ValidationIssue[] = parsed.error.issues.map((issue) => {
    const path = issuePath(issue.path);
    return {
      path,
      section: issueSection(path),
      message: issue.message,
    };
  });

  const issuesByPath: Record<string, string[]> = {};
  const sectionErrorCounts: Record<string, number> = {};

  for (const issue of issues) {
    const key = issue.path;
    if (!issuesByPath[key]) {
      issuesByPath[key] = [];
    }
    issuesByPath[key].push(issue.message);

    sectionErrorCounts[issue.section] = (sectionErrorCounts[issue.section] ?? 0) + 1;
  }

  return {
    valid: false,
    issues,
    issuesByPath,
    sectionErrorCounts,
  };
}
