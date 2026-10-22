import { AsyncLocalStorage } from "node:async_hooks";
import type {
  PreparedSessionEntryWorkerRead,
  SessionEntryWorkerRead,
} from "../../config/sessions/session-entry-read-runtime.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import type {
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRequester,
  ReplyToolAuthorityPreparation,
  ReplyToolAuthorityRoute,
} from "../../sessions/session-controller.contracts.js";
import type {
  ReplyExecutionSelection,
  ReplyIncomingExecutionSelection,
} from "../../sessions/session-controller.execution-selection.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { ModelFallbackAvailability } from "../agent-scope.js";
import type { CronScheduledToolProjectionRequest } from "../exec-tool-target-pinning.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

/** Translation for current bundled sinks; this fact grants no input authority. */
export type ReplyQueueInputAdapter = "human-and-question-permission" | "legacy-question-category";

const replyQueueInputAdapters = new WeakMap<object, ReplyQueueInputAdapter>();

/** Keep adapter metadata on the existing host owner without changing its public shape. */
export function bindReplyQueueInputAdapter<T extends object>(
  owner: T,
  adapter: ReplyQueueInputAdapter,
): T {
  replyQueueInputAdapters.set(owner, adapter);
  return owner;
}

export function readReplyQueueInputAdapter(owner: object | undefined): ReplyQueueInputAdapter {
  return (owner && replyQueueInputAdapters.get(owner)) ?? "legacy-question-category";
}

export type AgentHarnessScheduledToolProjectionFactory = (
  sourceTool: AnyAgentTool,
  projection: CronScheduledToolProjectionRequest,
) => AnyAgentTool;

export type AgentHarnessTtsProvenanceTransfer = <T extends object>(
  toolResult: unknown,
  attemptResult: T,
  eligibleMediaUrls: readonly string[],
) => T;

/** The question owner batches these source-bound reads with its final session authorization. */
export type PreparedQuestionCallerRead = {
  reads: readonly SessionEntryWorkerRead[];
  prepareCurrent: () => Promise<void>;
  assertPrepared: (reads: readonly PreparedSessionEntryWorkerRead[]) => void;
  /** Retain owner-held policy facts; final checks never acquire a durable reader. */
  retainCurrent: () => { assertCurrent: () => void; release: () => void };
};

export type QuestionInputAuthority = {
  kind: "run" | "source-bound";
  assertCurrent: () => void;
  prepareCurrent?: () => Promise<void>;
  toolAuthorityPreparation?: ReplyToolAuthorityPreparation;
};

type QuestionDispatchCapability = {
  assertCompatibilityCurrent: () => void;
  callerRead?: PreparedQuestionCallerRead;
};
type QuestionDispatchCallback = () => void | Promise<void>;
const questionDispatchCapabilities = new WeakMap<
  QuestionDispatchCallback,
  QuestionDispatchCapability
>();

function bindQuestionDispatchCapability(
  assertCurrent: () => void,
  capability: QuestionDispatchCapability,
  prepareCurrent?: () => Promise<void>,
): void {
  questionDispatchCapabilities.set(assertCurrent, capability);
  if (prepareCurrent) {
    questionDispatchCapabilities.set(prepareCurrent, capability);
  }
}

export function readQuestionDispatchCapability(assertCurrent?: QuestionDispatchCallback) {
  return assertCurrent ? questionDispatchCapabilities.get(assertCurrent) : undefined;
}

/** Preserve reservation refusal tracking on every final policy check. */
export function bindQuestionDispatchGuard(
  assertCurrent: () => void,
  authority: QuestionInputAuthority | undefined,
  refuse: (error: unknown) => never,
) {
  const prepareCurrent =
    authority?.prepareCurrent &&
    (async () => {
      try {
        assertCurrent();
        await authority?.prepareCurrent?.();
        assertCurrent();
      } catch (error) {
        refuse(error);
      }
    });
  const guard = (check: () => void) => {
    try {
      assertCurrent();
      check();
      assertCurrent();
    } catch (error) {
      refuse(error);
    }
  };
  const capability = readQuestionDispatchCapability(authority?.assertCurrent);
  const callerRead = capability?.callerRead;
  bindQuestionDispatchCapability(
    assertCurrent,
    {
      assertCompatibilityCurrent: () =>
        guard(capability?.assertCompatibilityCurrent ?? assertCurrent),
      callerRead: callerRead && {
        reads: callerRead.reads,
        prepareCurrent: prepareCurrent!,
        assertPrepared: (reads: Parameters<PreparedQuestionCallerRead["assertPrepared"]>[0]) =>
          guard(() => callerRead.assertPrepared(reads)),
        retainCurrent: () => {
          let retained: ReturnType<PreparedQuestionCallerRead["retainCurrent"]>;
          try {
            retained = callerRead.retainCurrent();
          } catch (error) {
            return refuse(error);
          }
          return {
            release: retained.release,
            assertCurrent: () => guard(retained.assertCurrent),
          };
        },
      },
    },
    prepareCurrent,
  );
  return prepareCurrent;
}

export function prepareQuestionGatewayDispatch(
  authority?: { version: 2 } & QuestionInputAuthority,
  inProcess = false,
) {
  const capability = readQuestionDispatchCapability(authority?.assertCurrent);
  return {
    assertDispatchCurrent: inProcess
      ? authority?.assertCurrent
      : (capability?.assertCompatibilityCurrent ?? authority?.assertCurrent),
    prepareDispatchCurrent: authority?.prepareCurrent,
  };
}

/** Internal continuation input supplies caller policy, never replacement execution settings. */
export type ReplyToolAuthorityContinuation = Readonly<{
  kind: "continuation";
  caller: Omit<ReplyToolAuthorityOverlay, "traceAuthorized" | "allowCollaborativeSteering">;
  config: OpenClawConfig;
  executionSelection: ReplyIncomingExecutionSelection;
  delivery: {
    assertCurrent(): void;
    prepareCurrent(): Promise<void>;
    bindExecutionSelection(selection: ReplyExecutionSelection, config: OpenClawConfig): void;
  };
  selectedRoute: ReplyToolAuthorityRoute;
  fallbackAvailability: ModelFallbackAvailability;
}>;

export type ReplyToolAuthorityCaller =
  | ReplyToolAuthorityOverlay
  | ReplyToolAuthorityRequester
  | ReplyToolAuthorityContinuation;

type CallerReadPreparer = (
  caller: ReplyToolAuthorityCaller | undefined,
  fingerprint: string,
  route: ReplyToolAuthorityRoute | undefined,
  assertCurrent: () => void,
) => Promise<PreparedQuestionCallerRead | undefined>;
const callerReadPreparers = new WeakMap<object, CallerReadPreparer>();

export type PreparedToolAuthorityRead = {
  reads: readonly SessionEntryWorkerRead[];
  assertPrepared: (reads: readonly PreparedSessionEntryWorkerRead[]) => void;
  /** Ordinary legacy queue admission only; never call from a worker grant. */
  assertLegacyCurrent: () => void;
  retainCurrent?: PreparedQuestionCallerRead["retainCurrent"];
};
const toolAuthorityReadScope = new AsyncLocalStorage<{
  reads: PreparedToolAuthorityRead[];
  complete: boolean;
}>();
const workerToolPreparations = new WeakMap<() => Promise<void>, { complete: boolean }>();

export function bindWorkerToolPreparation<
  T extends Pick<ReplyToolAuthorityPreparation, "prepareCurrent">,
>(
  preparation: T,
  dependencies: readonly Pick<ReplyToolAuthorityPreparation, "prepareCurrent">[] = [],
): T {
  workerToolPreparations.set(preparation.prepareCurrent, {
    complete: dependencies.every(
      (dependency) => workerToolPreparations.get(dependency.prepareCurrent)?.complete === true,
    ),
  });
  return preparation;
}

export function isToolAuthorityReadCaptureActive(): boolean {
  return toolAuthorityReadScope.getStore() !== undefined;
}

export function recordPreparedToolAuthorityRead(read: PreparedToolAuthorityRead): void {
  toolAuthorityReadScope.getStore()?.reads.push(read);
}

export async function capturePreparedToolAuthorityReads(
  preparation: ReplyToolAuthorityPreparation,
) {
  const metadata = workerToolPreparations.get(preparation.prepareCurrent);
  const scope: { reads: PreparedToolAuthorityRead[]; complete: boolean } = {
    reads: [],
    complete: metadata?.complete ?? false,
  };
  if (metadata) {
    await toolAuthorityReadScope.run(scope, preparation.prepareCurrent);
  } else {
    await preparation.prepareCurrent();
  }
  preparation.assertCurrent();
  return {
    reads: scope.reads,
    // Known wrappers retain their own reads even when a dependency still needs
    // synchronous compatibility outside worker admission.
    assertCompatibility:
      !scope.complete || !scope.reads.length ? preparation.compatAssertCurrent : undefined,
  };
}

export function bindReplyToolAuthorityCallerRead(
  projector: object,
  prepare: CallerReadPreparer,
): void {
  callerReadPreparers.set(projector, prepare);
}

export async function prepareReplyToolAuthorityCallerRead(
  projector: object | undefined,
  caller: ReplyToolAuthorityCaller | undefined,
  fingerprint: string | undefined,
  route: ReplyToolAuthorityRoute | undefined,
  assertCurrent: () => void,
) {
  assertCurrent();
  const prepared =
    projector && fingerprint
      ? await callerReadPreparers.get(projector)?.(caller, fingerprint, route, assertCurrent)
      : undefined;
  const scope = toolAuthorityReadScope.getStore();
  if (scope && !prepared) {
    scope.complete = false;
  }
  return prepared;
}

function assertQuestionCompatibilityCurrent(
  assertActive: () => void,
  callerRead: PreparedQuestionCallerRead | undefined,
  fallback: () => void,
) {
  assertActive();
  const retained = callerRead?.retainCurrent();
  try {
    if (retained) {
      retained.assertCurrent();
    } else {
      warnPluginSdkDeprecation({
        family: "reply-tool-authority-sync-preparation",
        method: "question dispatcher authority.assertCurrent synchronous preparation",
        replacement: "await authority.assertCurrentAsync() before the final effect assertion",
      });
      fallback();
    }
  } finally {
    retained?.release();
  }
  assertActive();
}

/** Compose captured policy reads with the question owner's final synchronous admission. */
export async function prepareQuestionInputAuthority(authority: QuestionInputAuthority) {
  const preparation = authority.toolAuthorityPreparation;
  if (!preparation) {
    return authority;
  }
  const assertActive = () => {
    authority.assertCurrent();
    preparation.assertCurrent();
  };
  assertActive();
  const captured = await capturePreparedToolAuthorityReads(preparation);
  assertActive();
  const supported =
    !captured.assertCompatibility &&
    captured.reads.length > 0 &&
    captured.reads.every((read) => read.retainCurrent);
  const assertLegacyReads = () => {
    for (const read of captured.reads) {
      read.assertLegacyCurrent();
    }
  };
  const prepareCurrent = async () => {
    assertActive();
    await preparation.prepareCurrent();
    if (!supported) {
      assertLegacyReads();
    }
    assertActive();
  };
  const callerRead: PreparedQuestionCallerRead | undefined = supported
    ? {
        reads: captured.reads.flatMap((read) => read.reads),
        prepareCurrent,
        assertPrepared: (reads) => {
          assertActive();
          let offset = 0;
          for (const read of captured.reads) {
            read.assertPrepared(reads.slice(offset, offset + read.reads.length));
            offset += read.reads.length;
          }
          assertActive();
        },
        retainCurrent: () => {
          const retained: ReturnType<PreparedQuestionCallerRead["retainCurrent"]>[] = [];
          const release = () => {
            const errors: unknown[] = [];
            for (const read of retained.toReversed()) {
              try {
                read.release();
              } catch (error) {
                errors.push(error);
              }
            }
            throwSqliteLifecycleErrors(errors, "Question authority reader release failed");
          };
          try {
            for (const read of captured.reads) {
              retained.push(read.retainCurrent!());
            }
            return {
              release,
              assertCurrent: () => {
                assertActive();
                retained.forEach((read) => read.assertCurrent());
                assertActive();
              },
            };
          } catch (error) {
            release();
            throw error;
          }
        },
      }
    : undefined;
  const assertCompatibilityCurrent = () =>
    assertQuestionCompatibilityCurrent(assertActive, callerRead, () => {
      preparation.compatAssertCurrent();
      assertLegacyReads();
    });
  // Partial captures retain their opaque released guard; captured legacy reads
  // run during preparation or transport compatibility, never inside a grant.
  const assertCurrent = supported
    ? assertActive
    : () => {
        assertActive();
        preparation.compatAssertCurrent();
        assertActive();
      };
  bindQuestionDispatchCapability(assertCurrent, { assertCompatibilityCurrent, callerRead });
  return { kind: authority.kind, assertCurrent, prepareCurrent };
}

export async function prepareQuestionCallerAuthority(
  authority: PreparedQuestionAnswerAuthority,
  caller: ReplyToolAuthorityOverlay,
  assertActive: () => void,
): Promise<QuestionInputAuthority> {
  assertActive();
  const callerRead = await authority.prepareCaller?.(caller);
  assertActive();
  const assertCompatibilityCurrent = () =>
    assertQuestionCompatibilityCurrent(assertActive, callerRead, () =>
      authority.assertCaller(caller),
    );
  const assertCurrent = callerRead ? assertActive : assertCompatibilityCurrent;
  bindQuestionDispatchCapability(assertCurrent, { assertCompatibilityCurrent, callerRead });
  return {
    kind: "source-bound",
    assertCurrent,
    prepareCurrent: async () => {
      assertActive();
      if (callerRead) {
        await callerRead.prepareCurrent();
      } else {
        authority.assertCaller(caller);
      }
      assertActive();
    },
  };
}

export type PreparedQuestionAnswerAuthority = Readonly<{
  sessionKey: string;
  /** Host-admitted viewer identity, never a transport sender label. */
  requesterProfileId?: string;
  assertActive: () => void;
  assertCaller: (caller: ReplyToolAuthorityOverlay) => void;
  prepareCaller?: (
    caller: ReplyToolAuthorityOverlay,
  ) => Promise<PreparedQuestionCallerRead | undefined>;
  admitTranscriptAnswer?: (recorder: UserTurnTranscriptRecorder | undefined) => void;
}>;

const questionAnswerScope = new AsyncLocalStorage<PreparedQuestionAnswerAuthority | undefined>();
const questionAnswerCapabilities = new WeakMap<
  AgentHarnessHostCapabilities,
  PreparedQuestionAnswerAuthority
>();

/** Retain the creator's prepared policy; a matching hash alone never grants authority. */
export function createAgentQuestionAnswerAuthority(params: {
  sessionKey: string;
  requesterProfileId?: string;
  fingerprint: string | undefined;
  project: (caller: ReplyToolAuthorityOverlay) => string | undefined;
  prepareCaller?: PreparedQuestionAnswerAuthority["prepareCaller"];
  assertActive: () => void;
  admitTranscriptAnswer?: PreparedQuestionAnswerAuthority["admitTranscriptAnswer"];
}): PreparedQuestionAnswerAuthority {
  return Object.freeze({
    sessionKey: params.sessionKey.trim(),
    requesterProfileId: params.requesterProfileId,
    assertActive: params.assertActive,
    admitTranscriptAnswer: params.admitTranscriptAnswer,
    prepareCaller: params.prepareCaller,
    assertCaller: (caller: ReplyToolAuthorityOverlay) => {
      params.assertActive();
      const projected = params.project(caller);
      params.assertActive();
      if (!params.fingerprint || projected !== params.fingerprint) {
        throw new Error("question answer caller policy does not match its creator");
      }
    },
  });
}

export function withAgentQuestionAnswerAuthority<T>(
  authority: PreparedQuestionAnswerAuthority | undefined,
  run: () => T,
): T {
  return questionAnswerScope.run(authority, run);
}

export function registerAgentHarnessQuestionAnswerAuthority(
  hostCapabilities: AgentHarnessHostCapabilities,
  authority: PreparedQuestionAnswerAuthority,
): void {
  questionAnswerCapabilities.set(hostCapabilities, authority);
}

/** An explicit host carrier cannot fall back to an unrelated ambient creator. */
export function resolveAgentQuestionAnswerAuthority(
  hostCapabilities?: AgentHarnessHostCapabilities,
): PreparedQuestionAnswerAuthority | undefined {
  return hostCapabilities
    ? questionAnswerCapabilities.get(hostCapabilities)
    : questionAnswerScope.getStore();
}

export function captureAgentQuestionAnswerAuthority(
  sessionKey: string,
): PreparedQuestionAnswerAuthority | undefined {
  const authority = questionAnswerScope.getStore();
  authority?.assertActive();
  if (authority && authority.sessionKey !== sessionKey.trim()) {
    throw new Error("question creator authority belongs to another session");
  }
  return authority;
}

type RetainedBeforeToolCallRunner = Readonly<{
  assertActive: () => void;
  release: () => void;
  runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"];
}>;

const retainedBeforeToolCallRunners = new WeakMap<
  AgentHarnessHostCapabilities["runBeforeToolCall"],
  () => RetainedBeforeToolCallRunner | undefined
>();

/** Retain issued policy without importing the capability constructor and its tool graph. */
export function retainBeforeToolCallForNativeHookRelay(
  runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"],
): RetainedBeforeToolCallRunner | undefined {
  return retainedBeforeToolCallRunners.get(runBeforeToolCall)?.();
}

export function registerAgentHarnessBeforeToolCallRetention(
  runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"],
  retain: () => RetainedBeforeToolCallRunner | undefined,
): void {
  retainedBeforeToolCallRunners.set(runBeforeToolCall, retain);
}

const scheduledToolProjectionCapabilities = new WeakMap<
  AgentHarnessHostCapabilities,
  Readonly<{
    ownerPluginId: string;
    create: AgentHarnessScheduledToolProjectionFactory;
  }>
>();
const ttsProvenanceTransferCapabilities = new WeakMap<
  AgentHarnessHostCapabilities,
  Readonly<{ ownerPluginId: string; transfer: AgentHarnessTtsProvenanceTransfer }>
>();

export function registerAgentHarnessScheduledToolProjectionCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
  create: AgentHarnessScheduledToolProjectionFactory;
}): void {
  scheduledToolProjectionCapabilities.set(params.hostCapabilities, {
    ownerPluginId: params.ownerPluginId,
    create: params.create,
  });
}

/** Resolves a private issuer only for the exact authoritative plugin owner. */
export function resolveAgentHarnessScheduledToolProjectionCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
}): AgentHarnessScheduledToolProjectionFactory | undefined {
  const capability = scheduledToolProjectionCapabilities.get(params.hostCapabilities);
  return capability?.ownerPluginId === params.ownerPluginId ? capability.create : undefined;
}

export function registerAgentHarnessTtsProvenanceTransferCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
  transfer: AgentHarnessTtsProvenanceTransfer;
}): void {
  ttsProvenanceTransferCapabilities.set(params.hostCapabilities, {
    ownerPluginId: params.ownerPluginId,
    transfer: params.transfer,
  });
}

/** Resolves private TTS delivery transfer only for the exact authoritative plugin owner. */
export function resolveAgentHarnessTtsProvenanceTransferCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
}): AgentHarnessTtsProvenanceTransfer | undefined {
  const capability = ttsProvenanceTransferCapabilities.get(params.hostCapabilities);
  return capability?.ownerPluginId === params.ownerPluginId ? capability.transfer : undefined;
}
