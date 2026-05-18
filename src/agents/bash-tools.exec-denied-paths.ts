import path from "node:path";
import { buildCommandPayloadCandidates } from "../infra/command-analysis/risks.js";
import { analyzeShellCommand } from "../infra/exec-approvals-analysis.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { splitShellArgs } from "../utils/shell-argv.js";

type DeniedExecPathPattern = {
  root: string;
  recursive: boolean;
};

export type ExecDeniedPathNamespace = "host" | "sandbox" | "posix" | "win32";
type ExecPathOps = Pick<typeof path, "isAbsolute" | "parse" | "resolve" | "sep">;

export function resolveExecDeniedPathNamespaceForNode(
  platform: string | null | undefined,
): ExecDeniedPathNamespace {
  return normalizeLowercaseStringOrEmpty(platform ?? "").startsWith("win") ? "win32" : "posix";
}

function getExecPathOps(namespace: ExecDeniedPathNamespace): ExecPathOps {
  if (namespace === "host") {
    return path;
  }
  return namespace === "win32" ? path.win32 : path.posix;
}

function getExecCommandAnalysisPlatform(namespace: ExecDeniedPathNamespace): NodeJS.Platform {
  if (namespace === "host") {
    return process.platform;
  }
  return namespace === "win32" ? "win32" : "linux";
}

function normalizeDeniedExecPathPatterns(
  entries: string[] | undefined,
  workdir: string | undefined,
  namespace: ExecDeniedPathNamespace,
  env: NodeJS.ProcessEnv,
): DeniedExecPathPattern[] {
  const pathOps = getExecPathOps(namespace);
  const patterns: DeniedExecPathPattern[] = [];
  for (const entry of entries ?? []) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const recursive = trimmed.endsWith("/**") || trimmed.endsWith("\\**");
    const rawRoot = recursive ? trimmed.slice(0, -3) : trimmed;
    const rootInput =
      rawRoot || (trimmed.startsWith("/") ? pathOps.parse(pathOps.resolve("/")).root : "");
    if (!rootInput) {
      continue;
    }
    let root: string;
    if (rootInput === "~" || rootInput.startsWith("~/") || rootInput.startsWith("~\\")) {
      const home = normalizeOptionalString(env.HOME);
      if (!home) {
        throw new Error(
          `Security Violation: exec denied path pattern ${rootInput} requires HOME to resolve.`,
        );
      }
      root = rootInput === "~" ? pathOps.resolve(home) : pathOps.resolve(home, rootInput.slice(2));
    } else {
      root = pathOps.isAbsolute(rootInput)
        ? pathOps.resolve(rootInput)
        : pathOps.resolve(workdir ?? process.cwd(), rootInput);
    }
    patterns.push({ root, recursive });
  }
  return patterns;
}

function expandExecPathToken(token: string): string[] {
  const trimmed = token.trim();
  if (!trimmed) {
    return [];
  }
  const candidates = new Set<string>([trimmed]);
  const withoutRedirect = trimmed.replace(/^(?:\d*(?:>>?|<<?)|&>|>\|)/u, "");
  if (withoutRedirect !== trimmed && withoutRedirect) {
    candidates.add(withoutRedirect);
  }
  const assignmentIndex = trimmed.indexOf("=");
  if (assignmentIndex > 0 && assignmentIndex < trimmed.length - 1) {
    candidates.add(trimmed.slice(assignmentIndex + 1));
  }
  for (const embedded of extractEmbeddedExecPathTokens(trimmed)) {
    candidates.add(embedded);
  }
  return Array.from(candidates);
}

function extractEmbeddedExecPathTokens(token: string): string[] {
  const matches =
    token.match(/(?:\$\{HOME\}[\\/]|\$HOME[\\/]|~[\\/]|\.{1,2}[\\/]|\/)[^\s"'`;&|<>)]*/gu) ?? [];
  return matches.filter((match) => match !== "/" && match !== "./" && match !== "../");
}

function resolveHomePrefixedExecPathCandidate(
  value: string,
  env: NodeJS.ProcessEnv,
  pathOps: ExecPathOps,
): string | null {
  const home = normalizeOptionalString(env.HOME);
  if (!home) {
    return null;
  }
  if (value === "~" || value === "$HOME" || value === "${HOME}") {
    return pathOps.resolve(home);
  }
  for (const prefix of ["~/", "~\\", "$HOME/", "$HOME\\", "${HOME}/", "${HOME}\\"]) {
    if (value.startsWith(prefix)) {
      return pathOps.resolve(home, value.slice(prefix.length));
    }
  }
  return null;
}

function resolveExecPathCandidate(params: {
  raw: string;
  workdir: string | undefined;
  env: NodeJS.ProcessEnv;
  namespace: ExecDeniedPathNamespace;
}): string | null {
  const pathOps = getExecPathOps(params.namespace);
  const value = params.raw.trim();
  if (!value || value === "-") {
    return null;
  }
  if (pathOps.isAbsolute(value)) {
    return pathOps.resolve(value);
  }
  const homeCandidate = resolveHomePrefixedExecPathCandidate(value, params.env, pathOps);
  if (homeCandidate) {
    return homeCandidate;
  }
  if (/^\.{1,2}(?:[\\/]|$)/u.test(value) || value.includes("/") || value.includes("\\")) {
    return pathOps.resolve(params.workdir ?? process.cwd(), value);
  }
  return null;
}

function collectExecPathCandidates(params: {
  command: string;
  workdir: string | undefined;
  env: NodeJS.ProcessEnv;
  namespace: ExecDeniedPathNamespace;
}): string[] {
  const tokens: string[] = [];
  const pushArgvTokens = (argv: string[]) => {
    tokens.push(...argv);
    for (const payload of buildCommandPayloadCandidates(argv)) {
      tokens.push(payload);
      const payloadArgv = splitShellArgs(payload.trim());
      if (payloadArgv) {
        tokens.push(...payloadArgv);
      }
    }
  };
  const analysis = analyzeShellCommand({
    command: params.command,
    cwd: params.workdir,
    env: params.env,
    platform: getExecCommandAnalysisPlatform(params.namespace),
  });
  if (analysis.ok) {
    for (const segment of analysis.segments) {
      pushArgvTokens(segment.argv);
      const rawArgv = segment.raw ? splitShellArgs(segment.raw.trim()) : null;
      if (rawArgv) {
        pushArgvTokens(rawArgv);
      }
    }
  } else {
    const argv = splitShellArgs(params.command);
    if (argv) {
      pushArgvTokens(argv);
    }
  }

  const candidates = new Set<string>();
  for (const token of tokens) {
    for (const expanded of expandExecPathToken(token)) {
      const candidate = resolveExecPathCandidate({
        raw: expanded,
        workdir: params.workdir,
        env: params.env,
        namespace: params.namespace,
      });
      if (candidate) {
        candidates.add(candidate);
      }
    }
  }
  return Array.from(candidates);
}

function pathMatchesDeniedPattern(
  candidate: string,
  pattern: DeniedExecPathPattern,
  namespace: ExecDeniedPathNamespace,
): boolean {
  const matchCandidate = normalizeExecPathForDeniedMatch(candidate, namespace);
  const matchRoot = normalizeExecPathForDeniedMatch(pattern.root, namespace);
  if (!pattern.recursive) {
    return matchCandidate === matchRoot;
  }
  const pathOps = getExecPathOps(namespace);
  const rootPrefix = matchRoot.endsWith(pathOps.sep) ? matchRoot : `${matchRoot}${pathOps.sep}`;
  return matchCandidate === matchRoot || matchCandidate.startsWith(rootPrefix);
}

function normalizeExecPathForDeniedMatch(
  value: string,
  namespace: ExecDeniedPathNamespace,
): string {
  return namespace === "win32" ? value.toLowerCase() : value;
}

export function assertExecDeniedPaths(params: {
  deniedPaths: string[] | undefined;
  command: string;
  workdir: string | undefined;
  env: NodeJS.ProcessEnv;
  namespace?: ExecDeniedPathNamespace;
}): void {
  const namespace = params.namespace ?? "host";
  const pathOps = getExecPathOps(namespace);
  const patterns = normalizeDeniedExecPathPatterns(
    params.deniedPaths,
    params.workdir,
    namespace,
    params.env,
  );
  if (patterns.length === 0) {
    return;
  }
  const candidates = collectExecPathCandidates({
    command: params.command,
    workdir: params.workdir,
    env: params.env,
    namespace,
  });
  if (params.workdir) {
    candidates.push(pathOps.resolve(params.workdir));
  }
  for (const candidate of candidates) {
    const matched = patterns.find((pattern) =>
      pathMatchesDeniedPattern(candidate, pattern, namespace),
    );
    if (matched) {
      throw new Error(`Security Violation: exec command references denied path ${candidate}`);
    }
  }
}
