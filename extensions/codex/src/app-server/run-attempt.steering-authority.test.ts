import {
  runAgentHarnessGatewayQuestion,
  type setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { registerAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  createStartedThreadHarness,
  createTestParams,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

const registrations = vi.hoisted(() => vi.fn());
type QuestionDispatcher = Extract<
  Parameters<typeof runAgentHarnessGatewayQuestion>[0]["gatewayCall"],
  { version: 2 }
>;

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    setActiveEmbeddedRun: (...args: Parameters<typeof actual.setActiveEmbeddedRun>) => {
      registrations(...args);
      return actual.setActiveEmbeddedRun(...args);
    },
  };
});

setupRunAttemptTestHooks();

describe("Codex source-bound pending input", () => {
  it("retains the resolved agent in a raw global registration", async () => {
    registrations.mockClear();
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.agentId = "ops";
    params.sessionKey = "global";
    params.config = {
      ...params.config,
      agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
      session: { scope: "global" },
    };
    const run = runCodexAppServerAttempt(params);
    try {
      await harness.waitForMethod("turn/start");
      await vi.waitFor(() => {
        expect(registrations).toHaveBeenCalledWith(
          params.sessionId,
          expect.anything(),
          "global",
          params.sessionFile,
          "ops",
        );
      }, fastWait);
    } finally {
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    }
  });

  it("stops attachment transfer when its message source closes while the run stays active", async () => {
    registrations.mockClear();
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    const preparing = createDeferred<void>();
    const resume = createDeferred<void>();
    const writeRemoteFile = vi.fn();
    let sourceCurrent = true;
    const release = registerAgentWorkspaceAccess(params.workspaceDir, {
      bridge: {
        readFileWithSource: async () => {
          throw Object.assign(new Error("No bootstrap file"), { code: "ENOENT" });
        },
        readFile: async () => Buffer.alloc(0),
        writeFile: async () => {},
        stat: async () => null,
      },
      prepareTurnAttachments: async (_turn, assertCurrent) => {
        preparing.resolve();
        await resume.promise;
        assertCurrent();
        writeRemoteFile();
        return "Attachment ready.";
      },
    });
    const controller = new AbortController();
    const run = runCodexAppServerAttempt({ ...params, abortSignal: controller.signal });
    let delivery: Promise<unknown> | undefined;
    try {
      await harness.waitForMethod("turn/start");
      let handle: Parameters<typeof setActiveEmbeddedRun>[1] | undefined;
      await vi.waitFor(() => {
        handle = registrations.mock.calls.findLast((call) => call[0] === params.sessionId)?.[1];
        expect(handle?.messageInjectionV2).toBeDefined();
      }, fastWait);
      delivery = handle!
        .messageInjectionV2!.queueMessage(
          "read this document",
          { debounceMs: 0, media: [{ path: "media://inbound/report.pdf" }] },
          () => {
            if (!sourceCurrent) {
              throw new Error("message source closed");
            }
          },
          "source-bound",
        )
        .catch((error: unknown) => error);
      await preparing.promise;
      sourceCurrent = false;
      resume.resolve();
      expect(await delivery).toMatchObject({ message: "message source closed" });
      expect(writeRemoteFile).not.toHaveBeenCalled();
      expect(handle!.isAborted?.()).toBe(false);
      expect(harness.requests.some(({ method }) => method === "turn/steer")).toBe(false);
    } finally {
      resume.resolve();
      controller.abort();
      await delivery;
      await run;
      release();
    }
  });

  it.each(["open", "closed"] as const)(
    "guards a Codex pending-question claim across registration: %s",
    async (transition) => {
      registrations.mockClear();
      const harness = createStartedThreadHarness();
      const params = createTestParams();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      let handle: Parameters<typeof setActiveEmbeddedRun>[1] | undefined;
      await vi.waitFor(() => {
        handle = registrations.mock.calls.findLast((call) => call[0] === params.sessionId)?.[1];
        expect(handle?.messageInjectionV2).toBeDefined();
      }, fastWait);
      const registration = createDeferred<void>();
      const registering = createDeferred<void>();
      const answer = createDeferred<Awaited<ReturnType<typeof runAgentHarnessGatewayQuestion>>>();
      const questionAbort = new AbortController();
      const gatewayCall = vi.fn(async (method: string, _options: unknown, raw: unknown) => {
        const input = raw as {
          id: string;
          answers?: { answers: Record<string, string[]> };
          cancel?: boolean;
        };
        if (method === "question.request") {
          registering.resolve();
          await registration.promise;
          return { id: input.id };
        }
        if (method === "question.waitAnswer") {
          return await answer.promise;
        }
        const result = input.cancel
          ? { status: "cancelled" as const }
          : { status: "answered" as const, answers: input.answers! };
        answer.resolve(result);
        return result;
      });
      const question = runAgentHarnessGatewayQuestion({
        sessionKey: params.sessionKey!,
        questions: [{ id: "mode", header: "Mode", question: "Continue?", options: [] }],
        timeoutMs: 60_000,
        gatewayCall: {
          version: 2,
          call: ({ method, options, params: requestParams, authority }) => {
            if (authority.kind === "source-bound") {
              authority.assertCurrent();
            }
            return gatewayCall(method, options, requestParams);
          },
        } satisfies QuestionDispatcher,
        delivery: {},
        signal: questionAbort.signal,
      });
      const questionOutcome = question.catch(() => undefined);
      try {
        await registering.promise;
        let sourceCurrent = true;
        const delivery = handle!
          .messageInjectionV2!.queueMessage(
            "controlled answer",
            { isInboundUserMessage: true },
            () => {
              if (!sourceCurrent) {
                throw new Error("source closed");
              }
            },
            "source-bound",
          )
          .then(
            () => "accepted",
            () => "rejected",
          );
        sourceCurrent = transition === "open";
        registration.resolve();
        expect(await delivery).toBe(sourceCurrent ? "accepted" : "rejected");
        expect(
          gatewayCall.mock.calls.filter(([method]) => method === "question.resolve"),
        ).toHaveLength(sourceCurrent ? 1 : 0);
        expect(handle!.isAborted?.()).toBe(false);
        if (!sourceCurrent) {
          await handle!.messageInjectionV2!.queueMessage(
            "independent answer",
            { isInboundUserMessage: true },
            () => {},
            "source-bound",
          );
        }
        await expect(questionOutcome).resolves.toMatchObject({
          status: "answered",
          answers: {
            answers: { mode: [sourceCurrent ? "controlled answer" : "independent answer"] },
          },
        });
        expect(harness.requests.some(({ method }) => method === "turn/steer")).toBe(false);
        expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
      } finally {
        registration.resolve();
        questionAbort.abort();
        await questionOutcome;
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await run;
      }
    },
  );
});
