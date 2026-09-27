import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { loadTranscriptEventsSync } from "openclaw/plugin-sdk/session-store-runtime";
import {
  asBoolean,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { QaSuiteInfraError, QaSuiteScenarioSkipError } from "./errors.js";
import { resolveQaLiveTurnTimeoutMs as liveTurnTimeoutMs } from "./live-timeout.js";
import {
  qaMockRequestCursorUrl,
  qaMockRequestsAfterUrl,
  readQaMockRequestCursor,
} from "./providers/shared/debug-request-cursor.js";
import {
  classifyToolResultFailure,
  isHardFailureToolOutputText,
  isWorkspaceBoundaryFailureToolOutput,
  readTranscriptToolEvidence,
} from "./runtime-tool-evidence.js";
import {
  type QaRuntimeToolCoverageMetadata,
  readRuntimeToolCoverageMetadata,
} from "./runtime-tool-metadata.js";
import { readRawQaSessionStore } from "./suite-runtime-agent-session.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type QaRuntimeToolFixtureConfig = Record<string, unknown>;

type QaRuntimeToolFixtureRequest = {
  body?: unknown;
  allInputText?: string;
  plannedToolCallId?: string;
  plannedToolName?: string;
  plannedToolArgs?: unknown;
  toolOutputCallId?: string;
  toolOutput?: string;
  toolOutputStructuredError?: unknown;
};

const RUNTIME_PARITY_SESSION_KEY_DETAIL_PREFIX = "RUNTIME_PARITY_SESSION_KEY=";
const RUNTIME_PATCH_HAPPY_FILENAME = "runtime-tool-fixture-patch.txt";
const RUNTIME_PATCH_HAPPY_CONTENTS = "runtime patch\n";
const RUNTIME_PATCH_DENIED_FILENAME = "runtime-tool-fixture-denied.txt";
const RUNTIME_PATCH_DENIED_CONTENTS = "runtime-tool-fixture-denied-original\n";

function runtimeParitySessionKeyDetails(...sessionKeys: string[]) {
  return sessionKeys.map(
    (sessionKey) => `${RUNTIME_PARITY_SESSION_KEY_DETAIL_PREFIX}${sessionKey}`,
  );
}

function runtimeToolFixtureDetails(details: string, ...sessionKeys: string[]) {
  return [details, ...runtimeParitySessionKeyDetails(...sessionKeys)].join("\n");
}

function runtimeToolFixtureError(error: unknown, ...sessionKeys: string[]) {
  const message = [
    ...runtimeParitySessionKeyDetails(...sessionKeys),
    formatErrorMessage(error),
  ].join("\n");
  return error instanceof QaSuiteInfraError
    ? new QaSuiteInfraError(error.code, message, { cause: error })
    : new Error(message, { cause: error });
}

type QaRuntimeToolFixtureDeps = {
  createSession: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "primaryModel" | "alternateModel" | "providerMode">,
    label: string,
    key?: string,
  ) => Promise<string>;
  readEffectiveTools: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "primaryModel" | "alternateModel" | "providerMode">,
    sessionKey: string,
  ) => Promise<Set<string>>;
  runAgentPrompt: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
    params: {
      sessionKey: string;
      message: string;
      timeoutMs?: number;
      transcriptToolName?: string;
      requireSuccessfulTranscriptToolResult?: boolean;
    },
  ) => Promise<unknown>;
  fetchJson: (url: string) => Promise<unknown>;
  ensureImageGenerationConfigured: (env: QaSuiteRuntimeEnv) => Promise<unknown>;
};

function readQaRuntimeToolFixtureRequests(raw: unknown): QaRuntimeToolFixtureRequest[] {
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function formatPlannedToolArgs(rawArgs: unknown) {
  const encodedArgs = JSON.stringify(rawArgs ?? {});
  return encodedArgs ?? "undefined";
}

function requestMatchesPrompt(request: QaRuntimeToolFixtureRequest, promptSnippet: string) {
  return (request.allInputText ?? "").includes(promptSnippet);
}

function requestHasToolOutput(request: QaRuntimeToolFixtureRequest) {
  return typeof request.toolOutput === "string" && request.toolOutput.trim().length > 0;
}

function requestHasHappyPathFailureToolOutput(request: QaRuntimeToolFixtureRequest) {
  return (
    request.toolOutputStructuredError === true ||
    (typeof request.toolOutput === "string" && isHardFailureToolOutputText(request.toolOutput))
  );
}

function requestHasFailureLikeToolOutput(request: QaRuntimeToolFixtureRequest) {
  return (
    typeof request.toolOutput === "string" &&
    classifyToolResultFailure({
      text: request.toolOutput,
      isError: request.toolOutputStructuredError,
    }).failure
  );
}

function formatRuntimePatchFailureOutput(request: QaRuntimeToolFixtureRequest): string {
  const text =
    typeof request.toolOutput === "string"
      ? request.toolOutput
          .replace(
            /\b(?:bearer\s+[a-z\d._~+/-]+=*|(?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*["']?[^\s"',;]+)/giu,
            "[REDACTED]",
          )
          .replace(
            /\b(?:sk|sess|ghp|gho|github_pat|xox[baprs])[-_][a-z\d_-]{8,}\b/giu,
            "[REDACTED]",
          )
          .slice(0, 240)
      : undefined;
  return JSON.stringify({ text, structuredError: request.toolOutputStructuredError === true });
}

function canonicalRuntimePatchPath(workspaceDir: string, filePath: string): string {
  const resolvedPath = path.resolve(workspaceDir, filePath);
  try {
    // Native patch paths resolve platform aliases after the target leaf is removed.
    return path.join(realpathSync.native(path.dirname(resolvedPath)), path.basename(resolvedPath));
  } catch {
    return resolvedPath;
  }
}

function matchesRuntimePatchInput(
  input: unknown,
  operation: "add" | "update",
  workspaceDir: string,
  patchWorkingDirectory = workspaceDir,
): boolean {
  if (typeof input !== "string") {
    return false;
  }
  const lines = input.replace(/\r\n?/gu, "\n").split("\n");
  while (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    return false;
  }
  const fileHeaders = lines.filter((line) => /^\*\*\* (?:Add|Update|Delete) File: /u.test(line));
  const expectedHeaderPrefix = operation === "add" ? "*** Add File: " : "*** Update File: ";
  const expectedPath =
    operation === "add" ? RUNTIME_PATCH_HAPPY_FILENAME : `../${RUNTIME_PATCH_DENIED_FILENAME}`;
  if (
    fileHeaders.length !== 1 ||
    !fileHeaders[0]?.startsWith(expectedHeaderPrefix) ||
    canonicalRuntimePatchPath(
      patchWorkingDirectory,
      fileHeaders[0].slice(expectedHeaderPrefix.length),
    ) !== canonicalRuntimePatchPath(workspaceDir, expectedPath)
  ) {
    return false;
  }
  return operation === "add"
    ? lines.includes("+runtime patch")
    : lines.includes("@@") &&
        lines.includes(`-${RUNTIME_PATCH_DENIED_CONTENTS.trimEnd()}`) &&
        lines.includes("+runtime patch outside the workspace");
}

function matchesRuntimePatchArguments(params: {
  args: unknown;
  workspaceDir: string;
  operation: "add" | "update";
}): boolean {
  let args = params.args;
  if (typeof args === "string") {
    if (matchesRuntimePatchInput(args, params.operation, params.workspaceDir)) {
      return true;
    }
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      return false;
    }
  }
  if (!isRecord(args)) {
    return false;
  }
  if (typeof args.input === "string") {
    const patchWorkingDirectory =
      typeof args.cwd === "string"
        ? path.resolve(params.workspaceDir, args.cwd)
        : params.workspaceDir;
    return matchesRuntimePatchInput(
      args.input,
      params.operation,
      params.workspaceDir,
      patchWorkingDirectory,
    );
  }
  const changes = args.changes;
  if (!Array.isArray(changes) || changes.length !== 1 || !isRecord(changes[0])) {
    return false;
  }
  const change = changes[0];
  if (typeof change.path !== "string") {
    return false;
  }
  const kind = change.kind;
  const operation = isRecord(kind) ? kind.type : kind;
  const expectedPath =
    params.operation === "add"
      ? path.resolve(params.workspaceDir, RUNTIME_PATCH_HAPPY_FILENAME)
      : path.resolve(params.workspaceDir, "..", RUNTIME_PATCH_DENIED_FILENAME);
  return (
    operation === params.operation &&
    canonicalRuntimePatchPath(params.workspaceDir, change.path) ===
      canonicalRuntimePatchPath(params.workspaceDir, expectedPath)
  );
}

function describeRuntimePatchArguments(args: unknown): string {
  if (typeof args === "string") {
    return JSON.stringify({
      type: "string",
      length: args.length,
      patchEnvelope: args.startsWith("*** Begin Patch"),
    });
  }
  if (!isRecord(args)) {
    return JSON.stringify({ type: args === null ? "null" : typeof args });
  }
  return JSON.stringify({
    type: "object",
    keys: Object.keys(args).toSorted(),
    inputType: typeof args.input,
    patchHeaders:
      typeof args.input === "string"
        ? args.input
            .replace(/\r\n?/gu, "\n")
            .split("\n")
            .filter((line) =>
              /^\*\*\* (?:Begin Patch|End Patch|Add File: |Update File: |Delete File: )/u.test(
                line,
              ),
            )
            .slice(0, 4)
        : undefined,
    changes: Array.isArray(args.changes)
      ? args.changes.map((change) => {
          if (!isRecord(change)) {
            return { type: change === null ? "null" : typeof change };
          }
          return {
            path: typeof change.path === "string" ? change.path : undefined,
            kind: isRecord(change.kind) ? change.kind.type : change.kind,
          };
        })
      : undefined,
  });
}

async function formatRuntimePatchMutationDiagnostics(params: {
  env: QaSuiteRuntimeEnv;
  deps: QaRuntimeToolFixtureDeps;
  requestCursor: number;
}) {
  const workspaceEntries = await fs
    .readdir(params.env.gateway.workspaceDir)
    .then((entries) => entries.toSorted().slice(0, 16))
    .catch(() => [] as string[]);
  const tempRootEntries = await fs
    .readdir(params.env.gateway.tempRoot)
    .then((entries) => entries.toSorted().slice(0, 16))
    .catch(() => [] as string[]);
  const gatewayPatchLogs = (params.env.gateway.logs?.() ?? "")
    .split(/\r?\n/u)
    .filter((line) =>
      /custom tool call output is missing|apply[._ -]?patch|failed to parse responseitem|duplicate|tool registration/iu.test(
        line,
      ),
    )
    .slice(-6)
    .map((line) =>
      line
        .replace(
          /\b(?:bearer\s+[a-z\d._~+/-]+=*|(?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*["']?[^\s"',;]+)/giu,
          "[REDACTED]",
        )
        .replace(/\b(?:sk|sess|ghp|gho|github_pat|xox[baprs])[-_][a-z\d_-]{8,}\b/giu, "[REDACTED]")
        .slice(0, 200),
    );
  const mockRequests = params.env.mock
    ? await params.deps
        .fetchJson(qaMockRequestsAfterUrl(params.env.mock.baseUrl, params.requestCursor))
        .then(readQaRuntimeToolFixtureRequests)
        .then((requests) =>
          requests.slice(-4).map((request) => {
            const body = isRecord(request.body) ? request.body : undefined;
            const tools = Array.isArray(body?.tools) ? body.tools : [];
            return {
              plannedToolName: request.plannedToolName,
              plannedToolCallId: request.plannedToolCallId,
              toolOutputCallId: request.toolOutputCallId,
              toolOutput: request.toolOutput?.slice(0, 256),
              patchToolTypes: tools.flatMap((tool) =>
                isRecord(tool) && tool.name === "apply_patch" && typeof tool.type === "string"
                  ? [tool.type]
                  : [],
              ),
            };
          }),
        )
        .catch(() => [])
    : [];
  return [
    `workspace=${params.env.gateway.workspaceDir}`,
    `workspaceEntries=${JSON.stringify(workspaceEntries)}`,
    `tempRootEntries=${JSON.stringify(tempRootEntries)}`,
    ...(gatewayPatchLogs.length > 0
      ? [`gatewayPatchLogs=${JSON.stringify(gatewayPatchLogs)}`]
      : []),
    ...(params.env.mock ? [`mockPatchRequests=${JSON.stringify(mockRequests)}`] : []),
  ].join("; ");
}

async function readSessionTranscriptBytes(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  sessionKey: string,
) {
  const store = await readRawQaSessionStore(env);
  const entry = store[sessionKey];
  const sessionId = normalizeOptionalString(entry?.sessionId);
  if (!sessionId) {
    throw new Error(`session transcript entry not found for ${sessionKey}`);
  }
  const transcriptBytes = loadTranscriptEventsSync({
    agentId: "qa",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(env.gateway.tempRoot, "state"),
    },
    sessionId,
    sessionKey,
  })
    .map((event) => JSON.stringify(event))
    .join("\n");
  if (!transcriptBytes.trim()) {
    throw new Error(`session transcript is empty for ${sessionKey}`);
  }
  return transcriptBytes;
}

async function readLiveToolEvidence(params: {
  env: Pick<QaSuiteRuntimeEnv, "gateway">;
  sessionKey: string;
  toolName: string;
}) {
  return readTranscriptToolEvidence(
    await readSessionTranscriptBytes(params.env, params.sessionKey),
    params.toolName,
  );
}

function requestLinksPlannedToolOutput(
  plannedRequest: QaRuntimeToolFixtureRequest,
  outputRequest: QaRuntimeToolFixtureRequest,
) {
  if (plannedRequest.plannedToolCallId || outputRequest.toolOutputCallId) {
    return Boolean(
      plannedRequest.plannedToolCallId &&
      outputRequest.toolOutputCallId &&
      plannedRequest.plannedToolCallId === outputRequest.toolOutputCallId,
    );
  }
  return Boolean(
    plannedRequest === outputRequest &&
    plannedRequest.plannedToolName &&
    requestHasToolOutput(outputRequest),
  );
}

function findPlannedRequest(params: {
  requests: readonly QaRuntimeToolFixtureRequest[];
  promptSnippet: string;
  excludedPromptSnippet?: string;
  toolName: string;
}) {
  return params.requests.find(
    (request) =>
      requestMatchesPrompt(request, params.promptSnippet) &&
      (!params.excludedPromptSnippet ||
        !requestMatchesPrompt(request, params.excludedPromptSnippet)) &&
      request.plannedToolName === params.toolName,
  );
}

function findExecutedRequest(params: {
  requests: readonly QaRuntimeToolFixtureRequest[];
  promptSnippet: string;
  excludedPromptSnippet?: string;
  toolName: string;
}) {
  let plannedRequest: QaRuntimeToolFixtureRequest | undefined;
  for (const request of params.requests) {
    if (!requestMatchesPrompt(request, params.promptSnippet)) {
      continue;
    }
    if (
      params.excludedPromptSnippet &&
      requestMatchesPrompt(request, params.excludedPromptSnippet)
    ) {
      continue;
    }
    if (request.plannedToolName === params.toolName) {
      plannedRequest ??= request;
      if (requestHasToolOutput(request) && requestLinksPlannedToolOutput(request, request)) {
        return { plannedRequest, outputRequest: request };
      }
      continue;
    }
    if (
      plannedRequest &&
      requestHasToolOutput(request) &&
      requestLinksPlannedToolOutput(plannedRequest, request)
    ) {
      return { plannedRequest, outputRequest: request };
    }
  }
  return null;
}

function formatKnownBrokenDetails(
  toolName: string,
  tools: Set<string>,
  config: QaRuntimeToolFixtureConfig,
) {
  const knownBroken = isRecord(config.knownBroken) ? config.knownBroken : {};
  const issue = normalizeOptionalString(knownBroken.issue) ?? "";
  const reason = normalizeOptionalString(knownBroken.reason) ?? "known broken runtime tool fixture";
  return [
    `known-broken ${toolName}: ${reason}`,
    issue ? `tracking: ${issue}` : undefined,
    `available tools: ${[...tools].toSorted().join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatExpectedUnavailableDetails(toolName: string, tools: Set<string>) {
  return [
    `expected-unavailable ${toolName}: this fixture is report-only for the current profile`,
    `available tools: ${[...tools].toSorted().join(", ")}`,
  ].join("\n");
}

function formatCodexNativeWorkspaceDetails(params: {
  toolName: string;
  tools: Set<string>;
  reason?: string;
  happyRequest?: QaRuntimeToolFixtureRequest;
  failureRequest?: QaRuntimeToolFixtureRequest;
}) {
  return [
    `codex-native-workspace ${params.toolName}: OpenClaw dynamic exposure is intentionally omitted because Codex owns this workspace operation natively`,
    params.reason ? `reason: ${params.reason}` : undefined,
    `available OpenClaw dynamic tools: ${[...params.tools].toSorted().join(", ")}`,
    params.happyRequest
      ? `${params.toolName} mock provider happy planned args (diagnostic only): ${formatPlannedToolArgs(params.happyRequest.plannedToolArgs)}`
      : undefined,
    params.failureRequest
      ? `${params.toolName} mock provider failure planned args (diagnostic only): ${formatPlannedToolArgs(params.failureRequest.plannedToolArgs)}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatReportOnlyMockDetails(params: {
  toolName: string;
  happyRequest: QaRuntimeToolFixtureRequest;
  failureRequest: QaRuntimeToolFixtureRequest;
}) {
  return [
    `${params.toolName} mock provider report-only: direct tool output is not required by this fixture`,
    `${params.toolName} mock provider happy planned args (diagnostic only): ${formatPlannedToolArgs(params.happyRequest.plannedToolArgs)}`,
    `${params.toolName} mock provider failure planned args (diagnostic only): ${formatPlannedToolArgs(params.failureRequest.plannedToolArgs)}`,
  ].join("\n");
}

function isAsyncReportOnlyMockCoverage(metadata: QaRuntimeToolCoverageMetadata) {
  return !metadata.required && /\basync\b/iu.test(metadata.action ?? "");
}

function plannedRequestHasDeniedInputFailure(request: QaRuntimeToolFixtureRequest) {
  return (
    isRecord(request.plannedToolArgs) &&
    request.plannedToolArgs["__qaFailureMode"] === "denied-input"
  );
}

function plannedRequestHasPrompt(request: QaRuntimeToolFixtureRequest) {
  return (
    isRecord(request.plannedToolArgs) &&
    typeof request.plannedToolArgs.prompt === "string" &&
    request.plannedToolArgs.prompt.trim().length > 0
  );
}

function formatKnownHarnessGapDetails(toolName: string, config: QaRuntimeToolFixtureConfig) {
  const knownHarnessGap = isRecord(config.knownHarnessGap) ? config.knownHarnessGap : {};
  const issue = normalizeOptionalString(knownHarnessGap.issue) ?? "";
  const reason = normalizeOptionalString(knownHarnessGap.reason) ?? "known QA harness gap";
  return [`known-harness-gap ${toolName}: ${reason}`, issue ? `tracking: ${issue}` : undefined]
    .filter(Boolean)
    .join("\n");
}

export async function runRuntimeToolFixture(
  env: QaSuiteRuntimeEnv,
  config: QaRuntimeToolFixtureConfig,
  deps: QaRuntimeToolFixtureDeps,
) {
  const toolName = normalizeOptionalString(config.toolName) ?? "";
  if (!toolName) {
    throw new Error("runtime tool fixture missing execution.config.toolName");
  }
  if (config.ensureImageGeneration === true) {
    await deps.ensureImageGenerationConfigured(env);
  }
  await fs.writeFile(
    path.join(env.gateway.workspaceDir, "runtime-tool-fixture-edit.txt"),
    "before edit\n",
    "utf8",
  );

  const happySessionKey = await deps.createSession(
    env,
    `Runtime tool fixture: ${toolName} happy`,
    `agent:qa:runtime-tool:${toolName}:happy`,
  );
  const failureSessionKey = await deps.createSession(
    env,
    `Runtime tool fixture: ${toolName} failure`,
    `agent:qa:runtime-tool:${toolName}:failure`,
  );
  const sessionKeys = [happySessionKey, failureSessionKey] as const;
  const withSessionDetails = (details: string) =>
    runtimeToolFixtureDetails(details, ...sessionKeys);
  const skipFixture = (details: string): never => {
    throw new QaSuiteScenarioSkipError(withSessionDetails(details));
  };
  const fixtureError = (error: unknown) => runtimeToolFixtureError(error, ...sessionKeys);
  const failFixture: (details: string) => never = (details) => {
    if (isRecord(config.knownHarnessGap)) {
      skipFixture(formatKnownHarnessGapDetails(toolName, config));
    }
    throw fixtureError(new Error(details));
  };
  const runFixtureOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw fixtureError(error);
    }
  };
  const tools = await runFixtureOperation(() => deps.readEffectiveTools(env, happySessionKey));
  const metadata = readRuntimeToolCoverageMetadata({
    config,
  });
  const forcedCodexNativeWorkspace =
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME === "codex" &&
    metadata.expectedLayer === "codex-native-workspace";
  // Effective tool discovery may advertise the native name. The forced
  // runtime and scenario owner, not inventory absence, decide who executes it.
  const dynamicExposureIntentionallyExcluded = forcedCodexNativeWorkspace && !tools.has(toolName);
  const requireCodexNativePatchCoverage =
    forcedCodexNativeWorkspace && metadata.required && toolName === "apply_patch";
  const expectedAvailable = asBoolean(config.expectedAvailable) ?? true;
  if (!tools.has(toolName) && !dynamicExposureIntentionallyExcluded) {
    if (!expectedAvailable) {
      skipFixture(formatExpectedUnavailableDetails(toolName, tools));
    }
    if (isRecord(config.knownBroken)) {
      skipFixture(formatKnownBrokenDetails(toolName, tools, config));
    }
    failFixture(
      `${toolName} not present in effective tools. Available tools: ${[...tools].toSorted().join(", ")}`,
    );
  }

  const happyPrompt =
    normalizeOptionalString(config.happyPrompt) ??
    `tool search qa check target=${toolName}. Call exactly that tool once and then summarize.`;
  const failurePrompt =
    normalizeOptionalString(config.failurePrompt) ??
    `tool search qa failure target=${toolName}. Exercise the denied-input path once and then summarize.`;
  const promptSnippet = normalizeOptionalString(config.promptSnippet) ?? `target=${toolName}`;
  const failurePromptSnippet =
    normalizeOptionalString(config.failurePromptSnippet) ?? `failure target=${toolName}`;
  const happyPathOutputRequired = asBoolean(config.happyPathOutputRequired) ?? true;
  // Private QA can expose an actual dynamic patch tool. Real Codex instead
  // mirrors native file changes into linked apply_patch transcript evidence.
  const requireNativePatchTranscriptEvidence = !env.mock && requireCodexNativePatchCoverage;
  const requireTranscriptEvidence =
    metadata.required &&
    (!env.mock || toolName !== "apply_patch") &&
    (!dynamicExposureIntentionallyExcluded || requireNativePatchTranscriptEvidence) &&
    !isRecord(config.knownHarnessGap);
  const mockBaseUrl = env.mock?.baseUrl;
  const requestCursorBefore = mockBaseUrl
    ? await runFixtureOperation(async () =>
        readQaMockRequestCursor(await deps.fetchJson(qaMockRequestCursorUrl(mockBaseUrl))),
      )
    : 0;

  await runFixtureOperation(async () => {
    const runHappyPrompt = () =>
      deps.runAgentPrompt(env, {
        sessionKey: happySessionKey,
        message: happyPrompt,
        timeoutMs: liveTurnTimeoutMs(env, 45_000),
        ...(happyPathOutputRequired && requireTranscriptEvidence
          ? { transcriptToolName: toolName, requireSuccessfulTranscriptToolResult: true }
          : {}),
      });
    if (toolName !== "apply_patch" || !metadata.required) {
      return runHappyPrompt();
    }
    const happyPatchPath = path.join(env.gateway.workspaceDir, RUNTIME_PATCH_HAPPY_FILENAME);
    const readHappyPatchContents = async () =>
      fs.readFile(happyPatchPath, "utf8").catch((error: unknown) => {
        if (isRecord(error) && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      });
    if ((await readHappyPatchContents()) !== undefined) {
      throw new Error(
        `apply_patch happy-path target already exists: ${RUNTIME_PATCH_HAPPY_FILENAME}`,
      );
    }
    try {
      const result = await runHappyPrompt();
      if ((await readHappyPatchContents()) !== RUNTIME_PATCH_HAPPY_CONTENTS) {
        const diagnostics = await formatRuntimePatchMutationDiagnostics({
          env,
          deps,
          requestCursor: requestCursorBefore,
        });
        throw new Error(
          `expected apply_patch to create ${RUNTIME_PATCH_HAPPY_FILENAME} with exact contents; ${diagnostics}`,
        );
      }
      return result;
    } finally {
      await fs.rm(happyPatchPath, { force: true });
    }
  });
  await runFixtureOperation(async () => {
    const runFailurePrompt = () =>
      deps.runAgentPrompt(env, {
        sessionKey: failureSessionKey,
        message: failurePrompt,
        timeoutMs: liveTurnTimeoutMs(env, 45_000),
        ...(requireTranscriptEvidence ? { transcriptToolName: toolName } : {}),
      });
    if (toolName !== "apply_patch") {
      return runFailurePrompt();
    }
    const deniedPatchPath = path.resolve(
      env.gateway.workspaceDir,
      "..",
      RUNTIME_PATCH_DENIED_FILENAME,
    );
    // Matching outside context makes failure evidence prove containment, not
    // merely that apply_patch could not find a file or match a hunk.
    await fs.writeFile(deniedPatchPath, RUNTIME_PATCH_DENIED_CONTENTS, {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      const result = await runFailurePrompt();
      const sentinelContents = await fs.readFile(deniedPatchPath, "utf8").catch(() => undefined);
      if (sentinelContents !== RUNTIME_PATCH_DENIED_CONTENTS) {
        throw new Error("apply_patch modified or removed the outside-workspace sentinel");
      }
      return result;
    } finally {
      await fs.rm(deniedPatchPath, { force: true });
    }
  });

  if (!env.mock) {
    const happyRequest = await runFixtureOperation(() =>
      readLiveToolEvidence({
        env,
        sessionKey: happySessionKey,
        toolName,
      }),
    );
    if (!happyRequest.outputRequest) {
      const happyPlannedOnly = happyRequest.plannedRequest && !happyPathOutputRequired;
      if (happyPlannedOnly) {
        skipFixture(
          `${toolName} live provider report-only: a planned call without a linked successful result is not product execution evidence`,
        );
      } else {
        failFixture(
          happyRequest.plannedRequest
            ? `expected live happy-path tool output for ${toolName}`
            : `expected live happy-path tool call for ${toolName}`,
        );
      }
    }
    if (happyRequest.outputRequest?.hardFailure) {
      failFixture(`expected live happy-path successful tool output for ${toolName}`);
    }
    if (
      toolName === "apply_patch" &&
      metadata.required &&
      !matchesRuntimePatchArguments({
        args: happyRequest.executedRequest?.args,
        workspaceDir: env.gateway.workspaceDir,
        operation: "add",
      })
    ) {
      throw fixtureError(
        new Error(
          `expected linked live apply_patch to add ${RUNTIME_PATCH_HAPPY_FILENAME}; observed linked arguments: ${describeRuntimePatchArguments(happyRequest.executedRequest?.args)}`,
        ),
      );
    }
    const failureRequest = await runFixtureOperation(() =>
      readLiveToolEvidence({
        env,
        sessionKey: failureSessionKey,
        toolName,
      }),
    );
    if (!failureRequest.outputRequest) {
      failFixture(
        failureRequest.plannedRequest
          ? `expected live failure-path tool output for ${toolName}`
          : `expected live failure-path tool call for ${toolName}`,
      );
    }
    if (!failureRequest.failureOutputRequest) {
      failFixture(`expected live failure-path tool failure output for ${toolName}`);
    }
    if (
      toolName === "apply_patch" &&
      metadata.required &&
      !matchesRuntimePatchArguments({
        args: failureRequest.executedRequest?.args,
        workspaceDir: env.gateway.workspaceDir,
        operation: "update",
      })
    ) {
      throw fixtureError(
        new Error(
          `expected linked live apply_patch to update ../${RUNTIME_PATCH_DENIED_FILENAME}; observed linked arguments: ${describeRuntimePatchArguments(failureRequest.executedRequest?.args)}`,
        ),
      );
    }
    if (
      toolName === "apply_patch" &&
      !isWorkspaceBoundaryFailureToolOutput(failureRequest.failureOutputRequest?.text)
    ) {
      throw fixtureError(
        new Error("expected live apply_patch failure to explicitly reject the workspace boundary"),
      );
    }
    return withSessionDetails(
      [
        `${toolName} live provider happy planned args (diagnostic only): ${JSON.stringify(happyRequest.plannedRequest?.args ?? {})}`,
        happyPathOutputRequired
          ? undefined
          : `${toolName} live provider happy direct output not required for this async fixture`,
        `${toolName} live provider failure planned args (diagnostic only): ${JSON.stringify(failureRequest.plannedRequest?.args ?? {})}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const activeMockBaseUrl = env.mock.baseUrl;
  const requests = await runFixtureOperation(async () =>
    readQaRuntimeToolFixtureRequests(
      await deps.fetchJson(qaMockRequestsAfterUrl(activeMockBaseUrl, requestCursorBefore)),
    ),
  );
  const happyPlannedRequest = findPlannedRequest({
    requests,
    promptSnippet,
    excludedPromptSnippet: failurePromptSnippet,
    toolName,
  });
  const happyRequest = findExecutedRequest({
    requests,
    promptSnippet,
    excludedPromptSnippet: failurePromptSnippet,
    toolName,
  });
  const failurePlannedRequest = findPlannedRequest({
    requests,
    promptSnippet: failurePromptSnippet,
    toolName,
  });
  const failureRequest = findExecutedRequest({
    requests,
    promptSnippet: failurePromptSnippet,
    toolName,
  });
  if (
    isAsyncReportOnlyMockCoverage(metadata) &&
    happyPlannedRequest &&
    failurePlannedRequest &&
    !happyRequest
  ) {
    if (!plannedRequestHasPrompt(happyPlannedRequest)) {
      throw fixtureError(new Error(`expected mock happy-path prompt args for ${toolName}`));
    }
    if (!plannedRequestHasDeniedInputFailure(failurePlannedRequest)) {
      throw fixtureError(new Error(`expected mock failure-path denied-input args for ${toolName}`));
    }
    if (failureRequest && !requestHasFailureLikeToolOutput(failureRequest.outputRequest)) {
      throw fixtureError(
        new Error(`expected mock failure-path tool failure output for ${toolName}`),
      );
    }
    skipFixture(
      formatReportOnlyMockDetails({
        toolName,
        happyRequest: happyPlannedRequest,
        failureRequest: failurePlannedRequest,
      }),
    );
  }
  const happyPlannedOnly = Boolean(happyPlannedRequest && !happyPathOutputRequired);
  if (!happyRequest && happyPlannedOnly) {
    skipFixture(
      `${toolName} mock provider report-only: a planned call without a linked successful result is not product execution evidence`,
    );
  }
  if (!happyRequest && !happyPlannedOnly) {
    if (dynamicExposureIntentionallyExcluded && !requireCodexNativePatchCoverage) {
      skipFixture(
        formatCodexNativeWorkspaceDetails({
          toolName,
          tools,
          reason: metadata.reason,
          happyRequest: happyPlannedRequest,
        }),
      );
    }
    failFixture(
      happyPlannedRequest
        ? `expected mock happy-path tool output for ${toolName}`
        : `expected mock happy-path request for ${toolName}`,
    );
  }
  if (happyRequest && requestHasHappyPathFailureToolOutput(happyRequest.outputRequest)) {
    failFixture(`expected mock happy-path successful tool output for ${toolName}`);
  }
  if (
    toolName === "apply_patch" &&
    metadata.required &&
    happyRequest &&
    !matchesRuntimePatchArguments({
      args: happyRequest.plannedRequest.plannedToolArgs,
      workspaceDir: env.gateway.workspaceDir,
      operation: "add",
    })
  ) {
    throw fixtureError(
      new Error(`expected linked mock apply_patch to add ${RUNTIME_PATCH_HAPPY_FILENAME}`),
    );
  }
  if (!failureRequest) {
    if (dynamicExposureIntentionallyExcluded && !requireCodexNativePatchCoverage) {
      skipFixture(
        formatCodexNativeWorkspaceDetails({
          toolName,
          tools,
          reason: metadata.reason,
          happyRequest: happyPlannedRequest,
          failureRequest: failurePlannedRequest,
        }),
      );
    }
    failFixture(
      failurePlannedRequest
        ? `expected mock failure-path tool output for ${toolName}`
        : `expected mock failure-path request for ${toolName}`,
    );
  }
  if (!requestHasFailureLikeToolOutput(failureRequest.outputRequest)) {
    if (isRecord(config.knownHarnessGap)) {
      skipFixture(formatKnownHarnessGapDetails(toolName, config));
    }
    const patchFailureDiagnostics =
      toolName === "apply_patch"
        ? `; received ${formatRuntimePatchFailureOutput(failureRequest.outputRequest)}`
        : "";
    throw fixtureError(
      new Error(
        `expected mock failure-path tool failure output for ${toolName}${patchFailureDiagnostics}`,
      ),
    );
  }
  if (
    toolName === "apply_patch" &&
    metadata.required &&
    !matchesRuntimePatchArguments({
      args: failureRequest.plannedRequest.plannedToolArgs,
      workspaceDir: env.gateway.workspaceDir,
      operation: "update",
    })
  ) {
    throw fixtureError(
      new Error(`expected linked mock apply_patch to update ../${RUNTIME_PATCH_DENIED_FILENAME}`),
    );
  }
  if (
    toolName === "apply_patch" &&
    !isWorkspaceBoundaryFailureToolOutput(failureRequest.outputRequest.toolOutput)
  ) {
    throw fixtureError(
      new Error("expected mock apply_patch failure to explicitly reject the workspace boundary"),
    );
  }

  if (dynamicExposureIntentionallyExcluded && !requireCodexNativePatchCoverage) {
    skipFixture(
      formatCodexNativeWorkspaceDetails({
        toolName,
        tools,
        reason: metadata.reason,
        happyRequest: happyRequest?.plannedRequest ?? happyPlannedRequest,
        failureRequest: failureRequest.plannedRequest,
      }),
    );
  }

  return withSessionDetails(
    [
      `${toolName} mock provider happy planned args (diagnostic only): ${formatPlannedToolArgs((happyRequest?.plannedRequest ?? happyPlannedRequest)?.plannedToolArgs)}`,
      happyPathOutputRequired
        ? undefined
        : `${toolName} mock provider happy direct output not required for this async fixture`,
      `${toolName} mock provider failure planned args (diagnostic only): ${formatPlannedToolArgs(failureRequest.plannedRequest.plannedToolArgs)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
