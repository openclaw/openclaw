import fs from "node:fs/promises";
import path from "node:path";
import {
  asBoolean,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { QaSuiteScenarioSkipError } from "./errors.js";
import { resolveQaLiveTurnTimeoutMs as liveTurnTimeoutMs } from "./live-timeout.js";
import { readQaNativeWorkspaceBehaviorId } from "./native-workspace-behavior.js";
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
  runtimeParitySessionKeyDetails,
  runtimeToolFixtureError,
} from "./runtime-tool-fixture-session-details.js";
import {
  type QaRuntimeToolCoverageMetadata,
  readRuntimeToolCoverageMetadata,
} from "./runtime-tool-metadata.js";
import {
  canonicalWorkspacePath,
  formatCodexNativeWorkspaceDetails,
  readOptionalUtf8,
  runCodexNativeWorkspaceFixture,
} from "./runtime-tool-native-workspace.js";
import * as searchEvidence from "./runtime-tool-search-evidence.js";
import type { runAgentPrompt } from "./suite-runtime-agent-process.js";
import {
  type createSession,
  type readEffectiveTools,
  readQaSessionTranscriptEvents,
} from "./suite-runtime-agent-session.js";
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

const RUNTIME_PATCH_HAPPY_FILENAME = "runtime-tool-fixture-patch.txt";
const RUNTIME_PATCH_HAPPY_CONTENTS = "runtime patch\n";
const RUNTIME_PATCH_DENIED_FILENAME = "runtime-tool-fixture-denied.txt";
const RUNTIME_PATCH_DENIED_CONTENTS = "runtime-tool-fixture-denied-original\n";

type QaRuntimeToolFixtureDeps = {
  createSession: typeof createSession;
  readEffectiveTools: typeof readEffectiveTools;
  runAgentPrompt: (...args: Parameters<typeof runAgentPrompt>) => Promise<unknown>;
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

function requestHasToolOutput(
  request: QaRuntimeToolFixtureRequest,
): request is QaRuntimeToolFixtureRequest & { toolOutput: string } {
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

function redactRuntimePatchDiagnostic(text: string) {
  return text
    .replace(
      /\b(?:bearer\s+[a-z\d._~+/-]+=*|(?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*["']?[^\s"',;]+)/giu,
      "[REDACTED]",
    )
    .replace(/\b(?:sk|sess|ghp|gho|github_pat|xox[baprs])[-_][a-z\d_-]{8,}\b/giu, "[REDACTED]");
}

function formatRuntimePatchFailureOutput(request: QaRuntimeToolFixtureRequest): string {
  const text =
    typeof request.toolOutput === "string"
      ? redactRuntimePatchDiagnostic(request.toolOutput).slice(0, 240)
      : undefined;
  return JSON.stringify({ text, structuredError: request.toolOutputStructuredError === true });
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
    canonicalWorkspacePath(
      patchWorkingDirectory,
      fileHeaders[0].slice(expectedHeaderPrefix.length),
    ) !== canonicalWorkspacePath(workspaceDir, expectedPath)
  ) {
    return false;
  }
  // Update hunks may use a contextual @@ marker or omit the first marker entirely.
  return operation === "add"
    ? lines.includes("+runtime patch")
    : lines.includes(`-${RUNTIME_PATCH_DENIED_CONTENTS.trimEnd()}`) &&
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
    canonicalWorkspacePath(params.workspaceDir, change.path) ===
      canonicalWorkspacePath(params.workspaceDir, expectedPath)
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
  const readDirectoryEntries = (directory: string) =>
    fs
      .readdir(directory)
      .then((entries) => entries.toSorted().slice(0, 16))
      .catch(() => [] as string[]);
  const workspaceEntries = await readDirectoryEntries(params.env.gateway.workspaceDir);
  const tempRootEntries = await readDirectoryEntries(params.env.gateway.tempRoot);
  const gatewayPatchLogs = (params.env.gateway.logs?.() ?? "")
    .split(/\r?\n/u)
    .filter((line) =>
      /custom tool call output is missing|apply[._ -]?patch|failed to parse responseitem|duplicate|tool registration/iu.test(
        line,
      ),
    )
    .slice(-6)
    .map((line) => redactRuntimePatchDiagnostic(line).slice(0, 200));
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
  const { events } = await readQaSessionTranscriptEvents(env, sessionKey);
  const transcriptBytes = events.map((event) => JSON.stringify(event)).join("\n");
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

function findToolRequestEvidence(params: {
  requests: readonly QaRuntimeToolFixtureRequest[];
  promptSnippet: string;
  excludedPromptSnippet?: string;
  toolName: string;
}) {
  const plannedRequests: QaRuntimeToolFixtureRequest[] = [];
  let executedRequest: QaRuntimeToolFixtureRequest | undefined;
  let outputRequest: (QaRuntimeToolFixtureRequest & { toolOutput: string }) | undefined;
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
      plannedRequests.push(request);
    }
    if (!requestHasToolOutput(request)) {
      continue;
    }
    executedRequest =
      request.plannedToolName === params.toolName
        ? requestLinksPlannedToolOutput(request, request)
          ? request
          : undefined
        : plannedRequests.find((planned) => requestLinksPlannedToolOutput(planned, request));
    if (executedRequest) {
      outputRequest = request;
      break;
    }
  }
  const planned = plannedRequests[0];
  const output = outputRequest
    ? {
        text: outputRequest.toolOutput,
        hardFailure: requestHasHappyPathFailureToolOutput(outputRequest),
        failure: requestHasFailureLikeToolOutput(outputRequest),
        raw: outputRequest,
      }
    : undefined;
  return {
    plannedRequest: planned ? { args: planned.plannedToolArgs } : undefined,
    executedRequest: executedRequest
      ? {
          id: executedRequest.plannedToolCallId,
          args: executedRequest.plannedToolArgs,
        }
      : undefined,
    outputRequest: output,
    failureOutputRequest: output?.failure ? output : undefined,
  };
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

function formatReportOnlyMockDetails(params: {
  toolName: string;
  happyRequest: { args: unknown };
  failureRequest: { args: unknown };
}) {
  return [
    `${params.toolName} mock provider report-only: direct tool output is not required by this fixture`,
    `${params.toolName} mock provider happy planned args (diagnostic only): ${formatPlannedToolArgs(params.happyRequest.args)}`,
    `${params.toolName} mock provider failure planned args (diagnostic only): ${formatPlannedToolArgs(params.failureRequest.args)}`,
  ].join("\n");
}

function isAsyncReportOnlyMockCoverage(metadata: QaRuntimeToolCoverageMetadata) {
  return !metadata.required && /\basync\b/iu.test(metadata.action ?? "");
}

function plannedRequestHasDeniedInputFailure(request: { args: unknown }) {
  return isRecord(request.args) && request.args["__qaFailureMode"] === "denied-input";
}

function plannedRequestHasPrompt(request: { args: unknown }) {
  return (
    isRecord(request.args) &&
    typeof request.args.prompt === "string" &&
    request.args.prompt.trim().length > 0
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
  const metadata = readRuntimeToolCoverageMetadata({ config });
  const forcedCodexNativeWorkspace =
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME === "codex" &&
    metadata.expectedLayer === "codex-native-workspace";

  const nativeWorkspaceBehaviorId = forcedCodexNativeWorkspace
    ? readQaNativeWorkspaceBehaviorId(config.nativeWorkspaceBehavior)
    : undefined;
  await fs.writeFile(
    path.join(env.gateway.workspaceDir, "runtime-tool-fixture-edit.txt"),
    "before edit\n",
    "utf8",
  );

  const stableSessionKeyPrefix = nativeWorkspaceBehaviorId
    ? undefined
    : `agent:qa:runtime-tool:${toolName}`;
  const happySessionKey = await deps.createSession(
    env,
    `Runtime tool fixture: ${nativeWorkspaceBehaviorId ?? toolName} happy`,
    stableSessionKeyPrefix ? `${stableSessionKeyPrefix}:happy` : undefined,
  );
  const failureSessionKey = await deps.createSession(
    env,
    `Runtime tool fixture: ${nativeWorkspaceBehaviorId ?? toolName} failure`,
    stableSessionKeyPrefix ? `${stableSessionKeyPrefix}:failure` : undefined,
  );
  const sessionKeys = [happySessionKey, failureSessionKey] as const;
  const withSessionDetails = (details: string) =>
    [details, ...runtimeParitySessionKeyDetails(...sessionKeys)].join("\n");
  const skipFixture = (details: string): never => {
    throw new QaSuiteScenarioSkipError(withSessionDetails(details));
  };
  try {
    const assertPatchArguments = (
      args: unknown,
      operation: "add" | "update",
      provider: "live" | "mock",
    ) => {
      if (
        toolName === "apply_patch" &&
        metadata.required &&
        !matchesRuntimePatchArguments({ args, workspaceDir: env.gateway.workspaceDir, operation })
      ) {
        const target =
          operation === "add"
            ? RUNTIME_PATCH_HAPPY_FILENAME
            : `../${RUNTIME_PATCH_DENIED_FILENAME}`;
        const details =
          provider === "live"
            ? `; observed linked arguments: ${describeRuntimePatchArguments(args)}`
            : "";
        throw new Error(
          `expected linked ${provider} apply_patch to ${operation} ${target}${details}`,
        );
      }
    };
    const failFixture: (details: string) => never = (details) => {
      if (isRecord(config.knownHarnessGap)) {
        skipFixture(formatKnownHarnessGapDetails(toolName, config));
      }
      throw new Error(details);
    };
    const tools = await deps.readEffectiveTools(env, happySessionKey);
    if (forcedCodexNativeWorkspace) {
      const nativeDetails = await runCodexNativeWorkspaceFixture({
        env,
        behaviorId: nativeWorkspaceBehaviorId,
        required: metadata.required,
        happySessionKey,
        failureSessionKey,
        runAgentPrompt: deps.runAgentPrompt,
        readEvidence: (sessionKey, nativeToolName) =>
          readLiveToolEvidence({ env, sessionKey, toolName: nativeToolName }),
        failFixture,
      });
      if (nativeDetails) {
        return withSessionDetails(nativeDetails);
      }
    }
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
      ? readQaMockRequestCursor(await deps.fetchJson(qaMockRequestCursorUrl(mockBaseUrl)))
      : 0;

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
      await runHappyPrompt();
    } else {
      const happyPatchPath = path.join(env.gateway.workspaceDir, RUNTIME_PATCH_HAPPY_FILENAME);
      if ((await readOptionalUtf8(happyPatchPath)) !== undefined) {
        throw new Error(
          `apply_patch happy-path target already exists: ${RUNTIME_PATCH_HAPPY_FILENAME}`,
        );
      }
      try {
        await runHappyPrompt();
        if ((await readOptionalUtf8(happyPatchPath)) !== RUNTIME_PATCH_HAPPY_CONTENTS) {
          const diagnostics = await formatRuntimePatchMutationDiagnostics({
            env,
            deps,
            requestCursor: requestCursorBefore,
          });
          throw new Error(
            `expected apply_patch to create ${RUNTIME_PATCH_HAPPY_FILENAME} with exact contents; ${diagnostics}`,
          );
        }
      } finally {
        await fs.rm(happyPatchPath, { force: true });
      }
    }
    const runFailurePrompt = () =>
      deps.runAgentPrompt(env, {
        sessionKey: failureSessionKey,
        message: failurePrompt,
        timeoutMs: liveTurnTimeoutMs(env, 45_000),
        ...(requireTranscriptEvidence ? { transcriptToolName: toolName } : {}),
      });
    if (toolName !== "apply_patch") {
      await runFailurePrompt();
    } else {
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
        await runFailurePrompt();
        const sentinelContents = await fs.readFile(deniedPatchPath, "utf8").catch(() => undefined);
        if (sentinelContents !== RUNTIME_PATCH_DENIED_CONTENTS) {
          throw new Error("apply_patch modified or removed the outside-workspace sentinel");
        }
      } finally {
        await fs.rm(deniedPatchPath, { force: true });
      }
    }

    const requests = env.mock
      ? readQaRuntimeToolFixtureRequests(
          await deps.fetchJson(qaMockRequestsAfterUrl(env.mock.baseUrl, requestCursorBefore)),
        )
      : [];
    const mockEvidence = env.mock
      ? ([
          findToolRequestEvidence({
            requests,
            promptSnippet,
            excludedPromptSnippet: failurePromptSnippet,
            toolName,
          }),
          findToolRequestEvidence({ requests, promptSnippet: failurePromptSnippet, toolName }),
        ] as const)
      : undefined;
    const happyPlannedRequest = mockEvidence?.[0].plannedRequest;
    const failurePlannedRequest = mockEvidence?.[1].plannedRequest;
    if (
      mockEvidence &&
      isAsyncReportOnlyMockCoverage(metadata) &&
      happyPlannedRequest &&
      failurePlannedRequest &&
      !mockEvidence[0].outputRequest
    ) {
      if (!plannedRequestHasPrompt(happyPlannedRequest)) {
        throw new Error(`expected mock happy-path prompt args for ${toolName}`);
      }
      if (!plannedRequestHasDeniedInputFailure(failurePlannedRequest)) {
        throw new Error(`expected mock failure-path denied-input args for ${toolName}`);
      }
      if (mockEvidence[1].outputRequest && !mockEvidence[1].failureOutputRequest) {
        throw new Error(`expected mock failure-path tool failure output for ${toolName}`);
      }
      skipFixture(
        formatReportOnlyMockDetails({
          toolName,
          happyRequest: happyPlannedRequest,
          failureRequest: failurePlannedRequest,
        }),
      );
    }
    const provider = env.mock ? "mock" : "live";
    const plannedArgsDetails: string[] = [];
    const discoveryCallIds: [string | undefined, string | undefined] = [undefined, undefined];
    for (const [phase, sessionKey] of [
      ["happy", happySessionKey],
      ["failure", failureSessionKey],
    ] as const) {
      const happy = phase === "happy";
      const index = happy ? 0 : 1;
      const request =
        mockEvidence?.[index] ?? (await readLiveToolEvidence({ env, sessionKey, toolName }));
      if (!request.outputRequest) {
        if (happy && request.plannedRequest && !happyPathOutputRequired) {
          skipFixture(
            `${toolName} ${provider} provider report-only: a planned call without a linked successful result is not product execution evidence`,
          );
        }
        if (env.mock && dynamicExposureIntentionallyExcluded && !requireCodexNativePatchCoverage) {
          skipFixture(
            formatCodexNativeWorkspaceDetails({
              toolName,
              tools,
              reason: metadata.reason,
              happyRequest: happyPlannedRequest,
              ...(happy ? {} : { failureRequest: failurePlannedRequest }),
            }),
          );
        }
        failFixture(
          `expected ${provider} ${phase}-path ${request.plannedRequest ? "tool output" : env.mock ? "request" : "tool call"} for ${toolName}`,
        );
      }
      if (happy && request.outputRequest?.hardFailure) {
        failFixture(`expected ${provider} happy-path successful tool output for ${toolName}`);
      }
      if (!happy && !request.failureOutputRequest) {
        const raw = mockEvidence?.[index]?.outputRequest?.raw;
        const diagnostics =
          toolName === "apply_patch" && raw
            ? `; received ${formatRuntimePatchFailureOutput(raw)}`
            : "";
        failFixture(
          `expected ${provider} failure-path tool failure output for ${toolName}${diagnostics}`,
        );
      }
      assertPatchArguments(request.executedRequest?.args, happy ? "add" : "update", provider);
      if (
        !happy &&
        toolName === "apply_patch" &&
        !isWorkspaceBoundaryFailureToolOutput(request.failureOutputRequest?.text)
      ) {
        throw new Error(
          `expected ${provider} apply_patch failure to explicitly reject the workspace boundary`,
        );
      }
      discoveryCallIds[index] = request.executedRequest?.id;
      const plannedArgs = env.mock ? request.executedRequest?.args : request.plannedRequest?.args;
      plannedArgsDetails.push(
        `${toolName} ${provider} provider ${phase} planned args (diagnostic only): ${formatPlannedToolArgs(plannedArgs)}`,
      );
      if (happy && !happyPathOutputRequired) {
        plannedArgsDetails.push(
          `${toolName} ${provider} provider happy direct output not required for this async fixture`,
        );
      }
    }

    if (mockEvidence && dynamicExposureIntentionallyExcluded && !requireCodexNativePatchCoverage) {
      skipFixture(
        formatCodexNativeWorkspaceDetails({
          toolName,
          tools,
          reason: metadata.reason,
          happyRequest: mockEvidence[0].executedRequest,
          failureRequest: mockEvidence[1].executedRequest,
        }),
      );
    }

    const discoveryDetails =
      !env.mock && searchEvidence.needsSearchEvidence(env, metadata.capabilityLayer)
        ? await searchEvidence.requireRuntimeToolSearchDiscoveryDetails(env, {
            sessionKeys,
            callIds: discoveryCallIds,
            toolName,
          })
        : [];
    return withSessionDetails([...plannedArgsDetails, ...discoveryDetails].join("\n"));
  } catch (error) {
    if (error instanceof QaSuiteScenarioSkipError) {
      throw error;
    }
    throw runtimeToolFixtureError(error, ...sessionKeys);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
