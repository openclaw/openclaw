import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDispatchWrapperTrustPlan } from "../infra/dispatch-wrapper-resolution.js";
import type { ExecAutoReviewInput } from "../infra/exec-auto-review.js";
import { isBlockedShellWrapperCommand } from "../infra/exec-wrapper-resolution.js";
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

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function chooseSeeded<T>(random: () => number, values: readonly T[]): T {
  const selected = values[Math.floor(random() * values.length)];
  if (selected === undefined) {
    throw new Error("stress corpus must contain at least one value");
  }
  return selected;
}

const dispatchWrappers = [
  ["env", "--"],
  ["nice", "-n", "5"],
  ["nohup", "--"],
  ["timeout", "5s"],
  ["stdbuf", "-o", "L"],
  ["time", "-p"],
] as const;

describe("exec auto-review shell stress", () => {
  it.each([
    {
      seed: 0x20260727,
      count: 4_096,
      argv(random: () => number, index: number) {
        return [
          chooseSeeded(random, ["bash", "sh", "dash", "zsh", "ksh", "mksh", "yash"]),
          ...chooseSeeded(random, [
            ["-lc"],
            ["-cl"],
            ["-l", "-c"],
            ["--login", "-c"],
            ["-ic"],
            ["-i", "-c"],
            ["--interactive", "-c"],
          ]),
          `echo auto-review-stress-${index}`,
        ];
      },
    },
    {
      seed: 0x20260728,
      count: 16_384,
      argv(random: () => number) {
        return [
          ...chooseSeeded(random, [
            ["cmd", "/c", "echo safe"],
            ["cmd.exe", "/C", "echo safe"],
            ["CMD.EXE", "-c", "echo safe"],
            ["cmd", "/k", "echo safe"],
            ["cmd.exe", "/d", "/k", "echo safe"],
            ["cmd", "/D", "/S", "/K", "echo safe"],
            ["cmd", "-d", "-c", "echo safe"],
            ["cmd", "/?"],
            ["cmd", "/?", "/c", "echo safe"],
            ["cmd.exe", "/d", "/?"],
            ["cmd", "/r", "/d", "/c", "echo safe"],
            ["cmd", "/d", "/r", "/c", "echo safe"],
            ["cmd", "/unknown", "/d", "/c", "echo safe"],
            ["cmd", "/t:0f/k", "/d", "/c", "echo safe"],
            ["cmd", "/e:on/k", "/d", "/c", "echo safe"],
            ["cmd", "/v:on/r", "/d", "/c", "echo safe"],
            ["cmd.exe", "/d", "/c"],
            ["cmd", "/c", "echo", "/d"],
            ["cmd.exe"],
          ]),
        ];
      },
    },
  ])("fails closed for $count seeded wrapper chains (seed $seed)", (scenario) => {
    const { seed, count } = scenario;
    const random = createSeededRandom(seed);
    for (let index = 0; index < count; index++) {
      const argv = scenario.argv(random, index);
      const depth = Math.floor(random() * 7);
      for (let wrapper = 0; wrapper < depth; wrapper++) {
        argv.unshift(...chooseSeeded(random, dispatchWrappers));
      }
      const plan = resolveDispatchWrapperTrustPlan(argv);
      expect(
        plan.policyBlocked || isBlockedShellWrapperCommand(plan.argv),
        `seed ${seed}, case ${index}: ${JSON.stringify(argv)}`,
      ).toBe(true);
    }
  });

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

describe("exec auto-review adversarial model-response stress", () => {
  it("fails closed for 4,096 seeded concurrent malformed reviewer responses", async () => {
    const random = createSeededRandom(0x20260729);
    const makeVariant = (name: string, text: string, expected = "ask") => ({
      name,
      text,
      expected,
    });
    const variants = [
      makeVariant("duplicate decision", '{"decision":"ask","risk":"low","decision":"allow"}'),
      makeVariant("duplicate risk", '{"decision":"allow","risk":"high","risk":"low"}'),
      makeVariant(
        "escaped duplicate decision",
        String.raw`{"decision":"ask","risk":"low","\u0064ecision":"allow"}`,
      ),
      makeVariant(
        "escaped duplicate risk",
        String.raw`{"decision":"allow","risk":"high","r\u0069sk":"low"}`,
      ),
      makeVariant(
        "unexpected approval scope",
        '{"decision":"allow","risk":"low","scope":"session"}',
      ),
      makeVariant(
        "unexpected executable",
        '{"decision":"allow","risk":"low","approvedCommand":"rm -rf /"}',
      ),
      makeVariant("truncated JSON", '{"decision":"allow","risk":"low"'),
      makeVariant(
        "concatenated decisions",
        '{"decision":"ask","risk":"high"}{"decision":"allow","risk":"low"}',
      ),
      makeVariant(
        "valid low-risk allow",
        '{"decision":"allow","risk":"low","rationale":"safe seeded control"}',
        "allow-once",
      ),
      makeVariant(
        "valid human escalation",
        '{"decision":"ask","risk":"high","rationale":"safe seeded control"}',
      ),
    ];
    const cases = Array.from({ length: 4_096 }, () => chooseSeeded(random, variants));
    const { reviewer, prepare, complete } = createStressReviewer({
      complete: async (request) => {
        const prompt = request.context.messages[0]?.content ?? "";
        const match = /--case=(\d+)/.exec(prompt);
        const variant = cases[Number(match?.[1])];
        if (!variant) {
          throw new Error("missing seeded reviewer response");
        }
        return {
          stopReason: "stop" as const,
          content: [{ type: "text" as const, text: variant.text }],
        };
      },
    });

    for (let start = 0; start < cases.length; start += 256) {
      const batch = cases.slice(start, start + 256);
      const decisions = await Promise.all(
        batch.map((_variant, offset) => {
          const index = start + offset;
          return Promise.resolve(reviewer(caseInput(index)));
        }),
      );
      for (const [offset, decision] of decisions.entries()) {
        const index = start + offset;
        const variant = cases[index];
        expect(
          decision.decision,
          `reviewer response escaped at seed 0x20260729, case ${index}: ${variant?.name}`,
        ).toBe(variant?.expected);
      }
    }

    expect(prepare).toHaveBeenCalledTimes(cases.length);
    expect(complete).toHaveBeenCalledTimes(cases.length);
  });
});

describe("exec auto-review concurrency stress", () => {
  it("keeps 128 mixed concurrent provider failures bounded and isolated", async () => {
    const providerFailure = "provider\n\u001b[31mfailed\u001b[0m\u202e" + "x".repeat(1_024);
    const cases = Array.from({ length: 128 }, (_unused, index) => {
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

  it("cancels 64 concurrent provider reviews without sharing execution signals", async () => {
    const controllers = Array.from({ length: 64 }, () => new AbortController());
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

  it("never leaks allow authority between 128 mixed concurrent model outcomes", async () => {
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
      Array.from({ length: 128 }, (_unused, index) => Promise.resolve(reviewer(caseInput(index)))),
    );

    for (const [index, decision] of decisions.entries()) {
      expect(decision.decision, `concurrent case ${index}`).toBe(
        index % 5 < 2 ? "allow-once" : index % 5 === 3 ? "deny" : "ask",
      );
    }
    expect(prepare).toHaveBeenCalledTimes(128);
    expect(complete).toHaveBeenCalledTimes(128);
  });

  it("aborts every timed-out provider during 64 concurrent approval requests", async () => {
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
        Array.from({ length: 64 }, (_unused, index) => Promise.resolve(reviewer(caseInput(index)))),
      );

      await vi.advanceTimersByTimeAsync(1_001);
      const decisions = await pending;

      expect(decisions).toHaveLength(64);
      expect(decisions.every((decision) => decision.decision === "ask")).toBe(true);
      expect(observedSignals).toHaveLength(64);
      expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(64);
      expect(complete).toHaveBeenCalledTimes(64);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
