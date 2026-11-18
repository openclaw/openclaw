import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecAutoReviewInput } from "../infra/exec-auto-review.js";
import { buildExecAutoReviewInputForShellCommand } from "../plugin-sdk/agent-harness-exec-review-runtime.js";
import {
  input as baselineInput,
  preparedModel,
  response,
} from "./exec-auto-review.test-support.js";
import { createModelExecAutoReviewer } from "./exec-auto-reviewer.js";
import * as completionRuntime from "./simple-completion-runtime.js";

type ReviewerFixtures = Pick<
  typeof completionRuntime,
  "acquireSimpleCompletionModelForAgent" | "completeWithPreparedSimpleCompletionModel"
>;
const reviewerFixtures = new WeakMap<object, ReviewerFixtures>();

function reviewerFixture(cfg: object | undefined): ReviewerFixtures {
  const fixture = cfg && reviewerFixtures.get(cfg);
  if (!fixture) {
    throw new Error("missing configured stress reviewer fixture");
  }
  return fixture;
}

beforeEach(() => {
  vi.spyOn(completionRuntime, "acquireSimpleCompletionModelForAgent").mockImplementation((params) =>
    reviewerFixture(params.cfg).acquireSimpleCompletionModelForAgent(params),
  );
  vi.spyOn(completionRuntime, "completeWithPreparedSimpleCompletionModel").mockImplementation(
    (params) => reviewerFixture(params.cfg).completeWithPreparedSimpleCompletionModel(params),
  );
});
afterEach(() => vi.restoreAllMocks());

type StressCompletionRequest = {
  context: { messages: Array<{ content: string }> };
  options: { signal?: AbortSignal };
};

type StressCompletionResult = {
  stopReason: "stop";
  content: Array<{ type: "text"; text: string }>;
};

function caseInput(index: number, kind = "case"): ExecAutoReviewInput {
  return {
    ...baselineInput,
    command: `git status --${kind}=${index}`,
    argv: ["git", "status", `--${kind}=${index}`],
  };
}

function createStressReviewer(params: {
  complete: (request: StressCompletionRequest) => Promise<StressCompletionResult>;
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const prepare = vi.fn(async () => preparedModel());
  const complete = vi.fn(params.complete);
  const cfg = {};
  reviewerFixtures.set(cfg, {
    acquireSimpleCompletionModelForAgent:
      prepare as unknown as typeof import("./simple-completion-runtime.js").acquireSimpleCompletionModelForAgent,
    completeWithPreparedSimpleCompletionModel:
      complete as unknown as typeof import("./simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel,
  });
  const reviewer = createModelExecAutoReviewer({
    cfg,
    signal: params.signal,
    ...(params.timeoutMs === undefined ? {} : { reviewer: { timeoutMs: params.timeoutMs } }),
  });
  return { reviewer, prepare, complete };
}

function modelResponse(decision: "allow" | "deny" | "ask", risk: "low" | "medium") {
  return response(decision, risk, "stress fixture");
}

describe("exec auto-review shell stress", () => {
  it
    .runIf(process.platform !== "win32")
    .each([
      "bash -lc 'echo startup'",
      "bash -cl 'echo startup'",
      "bash -l -c 'echo startup'",
      "bash --login -c 'echo startup'",
      "bash -ic 'echo startup'",
      "bash -i -c 'echo startup'",
      "bash --interactive -c 'echo startup'",
      "sh -lc 'echo startup'",
      "/bin/sh -lc 'echo startup'",
      "dash -l -c 'echo startup'",
      "zsh -i -c 'echo startup'",
      "fish -C 'echo startup' -c 'echo payload'",
      "fish --init-command='echo startup' -c 'echo payload'",
      "nu --login -c 'echo startup'",
      "nu --interactive -c 'echo startup'",
      "nu --config /tmp/auto-review-stress.nu -c 'echo startup'",
      "busybox sh -lc 'echo startup'",
      "toybox sh -lc 'echo startup'",
      "env -- bash -lc 'echo startup'",
      "env BASH_ENV=/tmp/auto-review-stress bash -c 'echo startup'",
      "nice -n 5 bash -lc 'echo startup'",
      "nohup -- bash -lc 'echo startup'",
      "timeout 5s bash -lc 'echo startup'",
      "nohup -- nice -n 5 env -- bash -lc 'echo startup'",
      "sudo bash -lc 'echo startup'",
      "cmd /c echo safe",
      "cmd.exe /c echo safe",
      "CMD.EXE /C echo safe",
      "cmd -c echo safe",
      "cmd -d -c echo safe",
      "cmd /k echo safe",
      "cmd /d /k echo safe",
      "cmd /d",
      "cmd.exe",
      "cmd /d /c",
      "cmd /?",
      "cmd /? /c echo safe",
      "cmd /d /?",
      "cmd /r /d /c echo safe",
      "cmd /d /r /c echo safe",
      "cmd /unknown /d /c echo safe",
      "cmd /t:0f/k /d /c echo safe",
      "cmd /e:on/k /d /c echo safe",
      "cmd /v:on/r /d /c echo safe",
      "cmd /c echo /d",
      "env -- cmd.exe /c echo safe",
      "nohup -- nice -n 5 env -- cmd.exe /d /k echo safe",
      "pwsh -Command 'Write-Output safe'",
      "powershell -Command 'Write-Output safe'",
      "pwsh ./safe.ps1",
      "powershell ./safe.ps1",
      "pwsh -File ./safe.ps1",
      "pwsh",
      "pwsh -NoProfile",
      "pwsh -NoProfile -",
      "pwsh -NoProfile -- -",
      "pwsh -NoProfile ./safe.ps1",
      "pwsh -NoProfile -File ./safe.ps1",
      "pwsh -NoProfile -- ./safe.ps1",
      "powershell -NoProfile -PSConsoleFile ./evil.psc1 -Command 'Write-Output safe'",
      "powershell -NoProfile -pscf ./evil.psc1 -Command 'Write-Output safe'",
      "pwsh -NoProfile -ConfigurationFile /tmp/evil.pssc -Command 'Write-Output safe'",
      "pwsh -NoProfile -ConfigurationName Unreviewed -Command 'Write-Output safe'",
      "pwsh -NoProfile -SettingsFile /tmp/evil.json -Command 'Write-Output safe'",
      "pwsh -NoProfile -CustomPipeName unreviewed -Command 'Write-Output safe'",
      "pwsh -NoProfile -EncodedArguments ZQBjAGgAbwA= -Command 'Write-Output safe'",
      "pwsh -NoProfile -ea ZQBjAGgAbwA= -Command 'Write-Output safe'",
      "pwsh /NoProfile /ea ZQBjAGgAbwA= /Command 'Write-Output safe'",
      "env -- pwsh -NoProfile -ea ZQBjAGgAbwA= -Command 'Write-Output safe'",
      "pwsh -NoProfile -ServerMode -Command 'Write-Output safe'",
      "pwsh -NoProfile -s -Command 'Write-Output safe'",
      "pwsh -NoProfile -SocketServerMode -Command 'Write-Output safe'",
      "pwsh -NoProfile -so -Command 'Write-Output safe'",
      "pwsh -NoProfile -NamedPipeServerMode -Command 'Write-Output safe'",
      "pwsh -NoProfile -nam -Command 'Write-Output safe'",
      "powershell -NoProfile -V2SocketServerMode -Command 'Write-Output safe'",
      "powershell -NoProfile -v2so -Command 'Write-Output safe'",
      "pwsh /NoProfile /so /Command 'Write-Output safe'",
      "env -- pwsh -NoProfile -ServerMode -Command 'Write-Output safe'",
      "pwsh -NoProfile -Command -",
      "pwsh -NoProfile -File -",
      "pwsh -NoProfile -Interactive -Command 'Write-Output safe'",
      "pwsh -NoProfile -NoExit -Command 'Write-Output safe'",
      "pwsh /c 'Write-Output safe'",
      "pwsh -Login -Command 'Write-Output safe'",
      "pwsh -l -Command 'Write-Output safe'",
      "pwsh -Login -NoProfile -Command 'Write-Output safe'",
      "pwsh -NoProfile -Login -Command 'Write-Output safe'",
      "pwsh -Login -NoProfile ./safe.ps1",
      "pwsh -NoProfileLoadTime -Command 'Write-Output safe'",
      "pwsh -WorkingDir /nop -Command 'Write-Output safe'",
      "env -- pwsh -Command 'Write-Output safe'",
      "pwsh -EncodedCommand ZQBjAGgAbwAgAHAAdwBuAGUAZAA=",
      "pwsh /ec ZQBjAGgAbwAgAHAAdwBuAGUAZAA=",
      "pwsh -e ZQBjAGgAbwAgAHAAdwBuAGUAZAA=",
      "pwsh -en ZQBjAGgAbwAgAHAAdwBuAGUAZAA=",
      "pwsh /EncodedCommand ZQBjAGgAbwAgAHAAdwBuAGUAZAA=",
      "pwsh -NoProfile -EncodedCommand ZQBjAGgAbwAgAHAAdwBuAGUAZAA=",
      "pwsh -win hidden -if XML /ec ZQBjAGgAbwAgAHAAdwBuAGUAZAA=",
      "env -- pwsh /ec ZQBjAGgAbwAgAHAAdwBuAGUAZAA=",
      "echo safe && bash -lc 'echo startup'",
      "bash -lc 'echo startup",
    ])("keeps %s outside plugin auto-review", async (command) => {
    for (const host of ["gateway", "node", "codex-app-server"] as const) {
      await expect(
        buildExecAutoReviewInputForShellCommand({
          command,
          cwd: process.cwd(),
          host,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it
    .runIf(process.platform !== "win32")
    .each([
      "node --version",
      "git status",
      "printf safe",
      "cmd /d /c echo safe",
      "cmd.exe /d /s /c echo safe",
      "CMD.EXE /D /S /C echo safe",
      "cmd /d /s /q /c echo safe",
      "cmd /d /e:on /f:off /v:on /t:0f /c echo safe",
      "pwsh -NoProfile -Command 'Write-Output safe'",
      "pwsh -nop -c 'Write-Output safe'",
      "pwsh /NoProfile /c 'Write-Output safe'",
    ])("preserves ordinary reviewable command: %s", async (command) => {
    for (const host of ["gateway", "node", "codex-app-server"] as const) {
      await expect(
        buildExecAutoReviewInputForShellCommand({
          command,
          cwd: process.cwd(),
          host,
        }),
      ).resolves.toMatchObject({ command, host });
    }
  });
});

describe("exec auto-review concurrency stress", () => {
  it("keeps mixed concurrent provider failures bounded and isolated", async () => {
    const providerFailure = "provider\n\u001b[31mfailed\u001b[0m\u202e" + "x".repeat(1_024);
    const cases = Array.from({ length: 4 }, (_unused, index) => {
      const prepare = vi.fn(async () => {
        if (index % 4 === 0) {
          return { error: providerFailure };
        }
        return preparedModel();
      });
      const complete = vi.fn(async () => {
        if (index % 4 === 1) {
          return {
            stopReason: "error" as const,
            errorMessage: providerFailure,
            content: [],
          };
        }
        if (index % 4 === 2) {
          throw new Error(providerFailure);
        }
        return modelResponse("allow", "low");
      });
      const cfg = {};
      reviewerFixtures.set(cfg, {
        acquireSimpleCompletionModelForAgent:
          prepare as unknown as typeof import("./simple-completion-runtime.js").acquireSimpleCompletionModelForAgent,
        completeWithPreparedSimpleCompletionModel:
          complete as unknown as typeof import("./simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel,
      });
      const reviewer = createModelExecAutoReviewer({ cfg });
      return { reviewer, prepare, complete };
    });

    const decisions = await Promise.all(
      cases.map(({ reviewer }, index) =>
        Promise.resolve(reviewer(caseInput(index, "failure-case"))),
      ),
    );

    for (const [index, decision] of decisions.entries()) {
      expect(decision.decision, `provider failure case ${index}`).toBe(
        index % 4 === 3 ? "allow-once" : "ask",
      );
      expect(decision.rationale.length, `provider failure case ${index}`).toBeLessThanOrEqual(500);
      expect(decision.rationale, `provider failure case ${index}`).not.toMatch(
        /[\p{Cc}\p{Cf}\u2028\u2029]/u,
      );
      expect(cases[index]?.prepare).toHaveBeenCalledTimes(1);
      expect(cases[index]?.complete).toHaveBeenCalledTimes(index % 4 === 0 ? 0 : 1);
    }
  });

  it("cancels concurrent provider reviews without sharing execution signals", async () => {
    const controllers = Array.from({ length: 2 }, () => new AbortController());
    const observedSignals: AbortSignal[] = [];
    const requests = controllers.map((controller, index) => {
      const { reviewer } = createStressReviewer({
        signal: controller.signal,
        complete: async (request) => {
          const providerSignal = request.options.signal;
          if (!providerSignal) {
            throw new Error("review completion must receive an abort signal");
          }
          observedSignals.push(providerSignal);
          return await new Promise<StressCompletionResult>((_resolve, reject) => {
            providerSignal.addEventListener("abort", () => reject(new Error("provider aborted")), {
              once: true,
            });
          });
        },
      });
      return Promise.resolve(reviewer(caseInput(index, "cancel-case")));
    });
    const settled = Promise.allSettled(requests);
    await vi.waitFor(() => expect(observedSignals).toHaveLength(controllers.length));

    for (const [index, controller] of controllers.entries()) {
      controller.abort(new Error(`cancelled review ${index}`));
    }

    const results = await settled;
    for (const [index, result] of results.entries()) {
      expect(result.status, `cancelled review ${index}`).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ message: `cancelled review ${index}` });
      }
    }
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("never leaks allow authority between mixed concurrent model outcomes", async () => {
    const { reviewer, prepare, complete } = createStressReviewer({
      complete: async (request) => {
        const prompt = request.context.messages[0]?.content ?? "";
        const match = /--case=(\d+)/.exec(prompt);
        const index = Number(match?.[1]);
        await Promise.resolve();
        switch (index % 5) {
          case 0:
            return modelResponse("allow", "low");
          case 1:
            return modelResponse("allow", "medium");
          case 2:
            return modelResponse("ask", "medium");
          case 3:
            return modelResponse("deny", "medium");
          default:
            throw new Error("stress provider failure");
        }
      },
    });

    const decisions = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) => Promise.resolve(reviewer(caseInput(index)))),
    );

    for (const [index, decision] of decisions.entries()) {
      expect(decision.decision, `concurrent case ${index}`).toBe(
        index % 5 < 2 ? "allow-once" : index % 5 === 3 ? "deny" : "ask",
      );
    }
    expect(prepare).toHaveBeenCalledTimes(5);
    expect(complete).toHaveBeenCalledTimes(5);
  });

  it("aborts every timed-out provider during concurrent approval requests", async () => {
    vi.useFakeTimers();
    try {
      const observedSignals: AbortSignal[] = [];
      const { reviewer, prepare, complete } = createStressReviewer({
        timeoutMs: 1_000,
        complete: async (request) => {
          const signal = request.options.signal;
          if (!signal) {
            throw new Error("review completion must receive an abort signal");
          }
          observedSignals.push(signal);
          return await new Promise<StressCompletionResult>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("stress timeout")), {
              once: true,
            });
          });
        },
      });

      const pending = Promise.all(
        Array.from({ length: 2 }, (_unused, index) => Promise.resolve(reviewer(caseInput(index)))),
      );

      await vi.advanceTimersByTimeAsync(1_001);
      const decisions = await pending;

      expect(decisions).toHaveLength(2);
      expect(decisions.every((decision) => decision.decision === "ask")).toBe(true);
      expect(observedSignals).toHaveLength(2);
      expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
