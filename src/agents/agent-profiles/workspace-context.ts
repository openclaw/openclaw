import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
  trimBootstrapContent,
  USER_BOOTSTRAP_MAX_CHARS,
} from "../embedded-agent-helpers/bootstrap.js";
import type { EmbeddedContextFile } from "../embedded-agent-helpers/context-file.js";
import type { WorkspaceBootstrapFile } from "../workspace.js";
import type {
  OpenClawWorkspaceContext,
  OpenClawWorkspaceContextSection,
} from "./openclaw-extension.js";
import type { ResolvedAgentProfile } from "./resolve.js";

const CANONICAL_SECTION_BY_FILE = new Map<string, WorkspaceContextCanonicalSection>([
  ["agents.md", "agents"],
  ["soul.md", "soul"],
  ["identity.md", "identity"],
  ["user.md", "user"],
]);

type WorkspaceContextCanonicalSection = "agents" | "soul" | "identity" | "user";
type WorkspaceContextTruncationCause = "section-limit" | "aggregate-limit";

type WorkspaceContextAllocationEntry = {
  section: string;
  path: string;
  missing: boolean;
  rawChars: number;
  effectiveMaxChars: number;
  injectedChars: number;
  truncated: boolean;
  causes: WorkspaceContextTruncationCause[];
};

export type AgentProfileWorkspaceContextReport = {
  totalMaxChars: number;
  operatorMaxChars: number;
  operatorTotalMaxChars: number;
  rawChars: number;
  injectedChars: number;
  truncatedChars: number;
  entries: WorkspaceContextAllocationEntry[];
};

export type WorkspaceContextSourceFile = {
  name: string;
  path: string;
  content?: string;
  missing: boolean;
  /** Set only by the authenticated personal USER loader. */
  personalUser?: true;
};

type AllocationEntry = {
  section: string;
  source: WorkspaceContextSourceFile;
  effectiveMaxChars: number;
  rawContent: string;
  rawChars: number;
  finalContent: string;
  causes: WorkspaceContextTruncationCause[];
  /** Personal instructions are indivisible: they are kept whole or dropped, never cut. */
  indivisible: boolean;
};

function effectiveFileMaxChars(params: {
  name: string;
  profileMaxChars?: number;
  operatorMaxChars: number;
}): number {
  const operatorMaxChars =
    params.name.toLowerCase() === "user.md"
      ? Math.min(params.operatorMaxChars, USER_BOOTSTRAP_MAX_CHARS)
      : params.operatorMaxChars;
  return Math.max(1, Math.min(operatorMaxChars, params.profileMaxChars ?? operatorMaxChars));
}

function missingFileContent(file: WorkspaceContextSourceFile): string {
  return `[MISSING] Expected at: ${file.path}`;
}

function boundContent(params: { content: string; name: string; maxChars: number }): string {
  return trimBootstrapContent(params.content.trimEnd(), params.name, params.maxChars).content;
}

function proportionalLimits(
  entries: readonly AllocationEntry[],
  budget: number,
): Map<AllocationEntry, number> {
  const result = new Map<AllocationEntry, number>();
  const demands = entries.map((entry) => entry.finalContent.length);
  const totalDemand = demands.reduce((sum, value) => sum + value, 0);
  if (totalDemand <= budget) {
    entries.forEach((entry, index) => result.set(entry, demands[index] ?? 0));
    return result;
  }
  if (budget <= 0 || totalDemand === 0) {
    entries.forEach((entry) => result.set(entry, 0));
    return result;
  }

  const ranked = entries.map((entry, index) => {
    const exact = (demands[index]! * budget) / totalDemand;
    const floor = Math.floor(exact);
    result.set(entry, floor);
    return { entry, index, remainder: exact - floor };
  });
  let remaining = budget - [...result.values()].reduce((sum, value) => sum + value, 0);
  ranked.sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const candidate of ranked) {
    if (remaining <= 0) {
      break;
    }
    result.set(candidate.entry, (result.get(candidate.entry) ?? 0) + 1);
    remaining -= 1;
  }
  return result;
}

function applyProportionalLimit(params: {
  entries: AllocationEntry[];
  budget: number;
  cause: WorkspaceContextTruncationCause;
}): void {
  const limits = proportionalLimits(params.entries, params.budget);
  for (const entry of params.entries) {
    const limit = limits.get(entry) ?? 0;
    if (limit >= entry.finalContent.length) {
      continue;
    }
    entry.causes.push(params.cause);
    entry.finalContent =
      limit > 0 ? trimBootstrapContent(entry.rawContent, entry.source.name, limit).content : "";
  }
}

function sectionPolicy(
  policy: OpenClawWorkspaceContext,
  section: WorkspaceContextCanonicalSection,
): OpenClawWorkspaceContextSection {
  return policy.sections?.[section] ?? {};
}

function makeAllocationEntry(params: {
  section: string;
  source: WorkspaceContextSourceFile;
  maxChars?: number;
  operatorMaxChars: number;
}): AllocationEntry {
  const rawContent = params.source.missing
    ? missingFileContent(params.source)
    : (params.source.content ?? "").trimEnd();
  const effectiveMaxChars = effectiveFileMaxChars({
    name: params.source.name,
    profileMaxChars: params.maxChars,
    operatorMaxChars: params.operatorMaxChars,
  });
  const indivisible = params.source.personalUser === true && !params.source.missing;
  const finalContent = indivisible
    ? rawContent.length > effectiveMaxChars
      ? ""
      : rawContent
    : boundContent({
        content: rawContent,
        name: params.source.name,
        maxChars: effectiveMaxChars,
      });
  return {
    section: params.section,
    source: params.source,
    effectiveMaxChars,
    rawContent,
    rawChars: rawContent.length,
    finalContent,
    causes: finalContent.length < rawContent.length ? ["section-limit"] : [],
    indivisible,
  };
}

function applyAggregateLimit(entries: AllocationEntry[], totalMaxChars: number): void {
  const indivisible = entries.filter((entry) => entry.indivisible && entry.finalContent);
  const reservedChars = indivisible.reduce((sum, entry) => sum + entry.finalContent.length, 0);
  if (reservedChars > totalMaxChars) {
    // The whole personal file cannot fit, so fall back to the shared defaults.
    for (const entry of indivisible) {
      entry.finalContent = "";
      entry.causes.push("aggregate-limit");
    }
  }
  const reserved = reservedChars > totalMaxChars ? 0 : reservedChars;
  applyProportionalLimit({
    entries: entries.filter((entry) => !entry.indivisible),
    budget: totalMaxChars - reserved,
    cause: "aggregate-limit",
  });
}

export async function prepareAgentProfileWorkspaceContext(params: {
  resolvedProfile: ResolvedAgentProfile;
  bootstrapFiles: WorkspaceBootstrapFile[];
  config?: OpenClawConfig;
  agentId?: string | null;
  warn?: (message: string) => void;
}): Promise<
  | {
      sourceFiles: WorkspaceContextSourceFile[];
      /** Canonical and passthrough files, which keep their typed bootstrap names. */
      bootstrapFiles: WorkspaceBootstrapFile[];
      contextFiles: EmbeddedContextFile[];
      report: AgentProfileWorkspaceContextReport;
    }
  | undefined
> {
  const policy = params.resolvedProfile.profile.spec["openclaw.ai"]?.prompt?.workspaceContext;
  if (!policy) {
    return undefined;
  }

  const operatorMaxChars = resolveBootstrapMaxChars(params.config, params.agentId);
  const operatorTotalMaxChars = resolveBootstrapTotalMaxChars(params.config, params.agentId);
  const totalMaxChars = Math.min(
    policy.totalMaxChars ?? operatorTotalMaxChars,
    operatorTotalMaxChars,
  );
  const canonicalFiles: WorkspaceBootstrapFile[] = [];
  const passthroughFiles: WorkspaceBootstrapFile[] = [];
  const entries: AllocationEntry[] = [];

  for (const file of params.bootstrapFiles) {
    const section = CANONICAL_SECTION_BY_FILE.get(file.name.toLowerCase());
    if (!section) {
      passthroughFiles.push(file);
      continue;
    }
    const sectionConfig = sectionPolicy(policy, section);
    if (sectionConfig.include === false) {
      continue;
    }
    canonicalFiles.push(file);
    entries.push(
      makeAllocationEntry({
        section,
        source: file,
        maxChars: sectionConfig.maxChars,
        operatorMaxChars,
      }),
    );
  }

  applyAggregateLimit(entries, totalMaxChars);

  const managedContextFiles = entries
    .filter((entry) => entry.finalContent.length > 0)
    .map((entry) => ({
      path: entry.source.path,
      content: entry.finalContent,
      ...(entry.source.personalUser === true ? { personalUser: true as const } : {}),
    }));
  const managedChars = managedContextFiles.reduce((sum, file) => sum + file.content.length, 0);
  const remainingOperatorChars = operatorTotalMaxChars - managedChars;
  const passthroughContextFiles =
    remainingOperatorChars > 0
      ? buildBootstrapContextFiles(passthroughFiles, {
          maxChars: operatorMaxChars,
          totalMaxChars: remainingOperatorChars,
          warn: params.warn,
        })
      : [];

  for (const entry of entries) {
    if (entry.finalContent.length < entry.rawChars) {
      params.warn?.(
        `Agent Profile workspace context ${entry.section} is ${entry.rawChars} chars; injecting ${entry.finalContent.length} chars (${entry.causes.join(", ")})`,
      );
    }
  }

  const sourceFiles = [...entries.map((entry) => entry.source), ...passthroughFiles];
  const contextFiles = [...managedContextFiles, ...passthroughContextFiles];
  const rawChars = entries.reduce((sum, entry) => sum + entry.rawChars, 0);
  const injectedChars = entries.reduce((sum, entry) => sum + entry.finalContent.length, 0);
  return {
    sourceFiles,
    bootstrapFiles: [...canonicalFiles, ...passthroughFiles],
    contextFiles,
    report: {
      totalMaxChars,
      operatorMaxChars,
      operatorTotalMaxChars,
      rawChars,
      injectedChars,
      truncatedChars: Math.max(0, rawChars - injectedChars),
      entries: entries.map((entry) => ({
        section: entry.section,
        path: entry.source.path,
        missing: entry.source.missing,
        rawChars: entry.rawChars,
        effectiveMaxChars: entry.effectiveMaxChars,
        injectedChars: entry.finalContent.length,
        truncated: entry.finalContent.length < entry.rawChars,
        causes: entry.causes,
      })),
    },
  };
}
