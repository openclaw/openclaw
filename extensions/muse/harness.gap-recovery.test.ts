import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnOutcome } from "@muse-code/sdk";
import {
  onAgentEvent,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry, SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type * as ExecApprovalsRuntime from "openclaw/plugin-sdk/exec-approvals-runtime";
import {
  createAgentHarnessHostCapabilitiesForTest,
  runInHarnessToolAuthorityForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type * as TranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMuseAgentHarness, type MuseSessionBinding } from "./harness.js";
import { MusePool, type MuseRuntime } from "./src/runtime.js";

const writes = vi.hoisted(() => ({
  append: vi.fn(async (params: { messages: unknown[] }) => params.messages),
  publish: vi.fn(async () => undefined),
}));
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof TranscriptRuntime>()),
  appendSessionTranscriptMessagesByIdentity: writes.append,
  publishSessionTranscriptUpdateByIdentity: writes.publish,
}));
vi.mock("openclaw/plugin-sdk/exec-approvals-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof ExecApprovalsRuntime>()),
  loadExecApprovalsReadOnlyAsync: async () => ({ version: 1, agents: {} }),
}));

type SourceRange = Extract<TurnOutcome, { kind: "completed" }>["params"]["sourceRange"];

type PeerReceipt =
  | { method: string; params?: { cursor: string; limit: number } }
  | {
      kind: "source-provenance";
      carrier: "live" | "page";
      viewCursor: string;
      sourceRange: SourceRange;
    };

const fixture = fileURLToPath(new URL("./src/test-support/gap-muse.mjs", import.meta.url));
const warning =
  "Muse finished this turn, but OpenClaw could not recover part of its activity history. Some tool activity may be missing. Verify the task's result before repeating it.";
let workspace: string;
let runtime: MuseRuntime | undefined;
let harness: ReturnType<typeof createMuseAgentHarness>;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "muse-gap-"));
  runtime = undefined;
  writes.append.mockClear();
  writes.publish.mockReset();
  vi.stubEnv("OPENCLAW_STATE_DIR", join(workspace, "state"));
  vi.stubEnv("MUSE_GAP_RECEIPT", join(workspace, "receipt.jsonl"));
  vi.spyOn(SessionManager, "openModelContextAsync").mockResolvedValue(SessionManager.inMemory());
  // Observe the real lease/fold without replacing SDK routing, paging or projection.
  const acquire = vi.spyOn(MusePool.prototype, "acquire");
  acquire.mockImplementationOnce(async function (this: MusePool, ...args) {
    acquire.mockRestore();
    const lease = await this.acquire(...args);
    runtime = lease.runtime;
    return lease;
  });
});

afterEach(async () => {
  try {
    await harness?.dispose?.();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
  }
});

it.each([
  "no-tool",
  "recovered",
  "page-failed",
  "failed",
  "cancelled",
  "prior-unsafe",
  "model-revoked",
  "host-revoked",
])(
  "reports an incomplete native view without rewriting completion (%s)",
  async (mode) => {
    const bindings = new Map<string, MuseSessionBinding>();
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const warnings: string[] = [];
    const order: string[] = [];
    const revoked = mode === "model-revoked" || mode === "host-revoked";
    harness = createMuseAgentHarness({
      binaryPath: fixture,
      sessionStore: {
        lookup: async (key) => bindings.get(key),
        register: async (key, value) => void bindings.set(key, value),
        delete: async (key) => bindings.delete(key),
      },
      logger: {
        warn: (message) => {
          warnings.push(message);
          order.push("log");
        },
      },
    });
    const authStorage = AuthStorage.inMemory();
    const params: AgentHarnessAttemptParamsV2 = {
      runId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      sessionKey: "agent:main:muse-gap-test",
      workspaceDir: workspace,
      agentDir: workspace,
      sessionFile: join(workspace, "session.jsonl"),
      sessionTarget: {
        sessionId: "transcript-id",
        sessionKey: "agent:main:muse-gap-test",
        storePath: join(workspace, "sessions.json"),
      },
      provider: "meta",
      modelId: "muse-spark-1.3",
      model: {
        id: "muse-spark-1.3",
        name: "Muse Spark",
        provider: "meta",
        api: "openai-responses",
        baseUrl: "https://api.meta.ai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      },
      authStorage,
      authProfileStore: { version: 1, profiles: {} },
      modelRegistry: ModelRegistry.inMemory(authStorage),
      thinkLevel: "off",
      timeoutMs: 10_000,
      prompt: `gap-case:${revoked ? "page-failed" : mode === "prior-unsafe" ? "no-tool" : mode}`,
      ...(mode === "prior-unsafe"
        ? { initialReplayState: { replayInvalid: true, hadPotentialSideEffects: true } }
        : {}),
      onAgentEvent: (event) => {
        events.push(event);
        order.push(event.stream === "notice" ? "notice" : String(event.data.phase));
      },
      hostCapabilities: {
        kind: "agent-harness-host-capability",
        version: 1,
        assertActive: () => undefined,
        bindToolSurface: (tools) => tools,
        runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
        requestApproval: async () => ({ decision: "deny" }),
        waitForApproval: async () => undefined,
      },
    };
    let host: Awaited<ReturnType<typeof createAgentHarnessHostCapabilitiesForTest>> | undefined;
    let authorityRevoked = false;
    let deniedModel = false;
    if (revoked) {
      host = await createAgentHarnessHostCapabilitiesForTest({
        attempt: params,
        pluginId: "muse",
        nativeModelPolicySupport: "exact",
        operatorSource: {
          profileId: "muse-gap-operator",
          scopes: ["operator.write"],
          assertCurrent: () => undefined,
          modelPolicy: {
            models: [{ provider: params.provider, model: params.modelId }],
            allows: () => {
              deniedModel = mode === "model-revoked" && authorityRevoked;
              return !deniedModel;
            },
          },
        },
      });
      params.hostCapabilities = host.capabilities;
      // Publication follows the real SDK answer's persistence. Revoke before
      // consumeTurn settles, without timers or authority-check call counts.
      writes.publish.mockImplementation(async () => {
        authorityRevoked = true;
        if (mode === "host-revoked") {
          host?.close();
        }
      });
    }
    const notices: Array<{ runId: string; sessionKey?: string; data: Record<string, unknown> }> =
      [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.stream === "notice") {
        notices.push(event);
      }
    });
    try {
      const result = await runInHarnessToolAuthorityForTest(params, "muse", (admitted) =>
        harness.runAttempt(admitted),
      );
      const receipt = join(workspace, "receipt.jsonl");
      const requests: PeerReceipt[] = (await readFile(receipt, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const methods = requests.filter((row) => "method" in row);
      const effects = await readFile(`${receipt}.effect`, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return "";
        }
        throw error;
      });
      const noTool = mode === "no-tool" || mode === "prior-unsafe";
      const recovered = mode === "recovered";
      const incomplete = !noTool && !recovered;
      const session = [...runtime!.sessions.values()][0]!;
      expect(session.fold.current).toBe(!incomplete);
      expect(methods.filter((row) => row.method === "turn/start")).toHaveLength(1);
      const pages = methods.filter((row) => row.method === "view/page");
      expect(pages).toHaveLength(noTool ? 0 : 1);
      if (!noTool) {
        expect(pages[0]!.params).toMatchObject({ cursor: "before-hole", limit: 200 });
      }
      const provenance = requests.filter((row) => "kind" in row);
      const positions: Record<string, [string, number]> = {
        "before-hole": ["synthetic-turn-start-record", 1],
        "missing-tool": ["synthetic-tool-record", 2],
        "after-hole": ["synthetic-answer-record", 3],
        terminal: ["synthetic-terminal-record", 4],
        "cancel-terminal": ["synthetic-cancel-record", 5],
      };
      expect(provenance.length).toBeGreaterThanOrEqual(3);
      for (const row of provenance) {
        const [id, sequence] = positions[row.viewCursor]!;
        expect(row.sourceRange).toEqual({
          first: { id, sequence },
          last: { id, sequence },
          stream: { id: session.sessionId, kind: "session" },
        });
      }
      if (recovered) {
        const answer = provenance.filter((row) => row.viewCursor === "after-hole");
        expect(answer.map((row) => row.carrier)).toEqual(["live", "page"]);
        expect(answer[0]!.sourceRange).toEqual(answer[1]!.sourceRange);
      }
      expect(
        effects
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ).toEqual(
        noTool
          ? []
          : [{ operation: "append", value: "synthetic-write", turnId: expect.any(String) }],
      );
      expect(
        result.messagesSnapshot.filter((message) => message.role === "toolResult"),
      ).toHaveLength(recovered ? 1 : 0);
      expect(writes.append).toHaveBeenCalledTimes(recovered ? 2 : 1);
      expect(writes.publish).toHaveBeenCalledTimes(recovered ? 2 : 1);
      expect(result.assistantTexts).toEqual(["The synthetic task finished."]);
      if (revoked) {
        expect(authorityRevoked).toBe(true);
        expect(deniedModel).toBe(mode === "model-revoked");
      }
      expect(result.replayMetadata).toEqual({
        replaySafe: noTool && mode !== "prior-unsafe",
        hadPotentialSideEffects: !noTool || mode === "prior-unsafe",
      });
      if (!("terminal" in result)) {
        throw new Error("Muse must return its canonical terminal.");
      }
      expect(result.terminal.kind).toBe(
        mode === "failed" || mode === "host-revoked"
          ? "failed"
          : mode === "cancelled" || mode === "model-revoked"
            ? "aborted"
            : "ok",
      );
      const shouldWarn = mode === "page-failed";
      expect(events.filter((event) => event.stream === "notice")).toEqual(
        shouldWarn ? [{ stream: "notice", data: { phase: "warning", message: warning } }] : [],
      );
      expect(warnings.filter((message) => message === warning)).toEqual(
        shouldWarn ? [warning] : [],
      );
      expect(notices).toEqual(
        shouldWarn
          ? [
              expect.objectContaining({
                runId: params.runId,
                sessionKey: params.sessionKey,
                data: { phase: "warning", message: warning },
              }),
            ]
          : [],
      );
      if (shouldWarn) {
        expect(order.indexOf("log")).toBeLessThan(order.indexOf("end"));
        expect(order.indexOf("notice")).toBeLessThan(order.indexOf("end"));
      }
      // Reporting does not retire the host or resubmit the completed turn.
      expect(runtime!.closing).toBe(false);
      if (mode !== "failed" && !revoked) {
        expect(methods.filter((row) => row.method === "turn/interrupt")).toHaveLength(0);
      }
    } finally {
      unsubscribe();
      host?.close();
    }
  },
  15_000,
);
