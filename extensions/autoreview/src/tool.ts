import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const paths = () => Type.Optional(Type.Array(Type.String({ minLength: 1 })));
export const autoReviewParameters = Type.Object(
  {
    mode: Type.Optional(
      Type.Union(
        ["auto", "local", "uncommitted", "branch", "commit"].map((value) => Type.Literal(value)),
      ),
    ),
    base: Type.Optional(Type.String()),
    commit: Type.Optional(Type.String()),
    model: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Only supply an explicitly requested reviewer model override.",
      }),
    ),
    thinking: Type.Optional(Type.String({ minLength: 1 })),
    maxPriority: Type.Optional(
      Type.Union(["P0", "P1", "P2", "P3"].map((value) => Type.Literal(value))),
    ),
    passes: Type.Optional(Type.Integer({ minimum: 1 })),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
    prompt: Type.Optional(Type.String()),
    promptFiles: paths(),
    datasets: paths(),
    sourceContext: paths(),
    sourceContextFiles: paths(),
  },
  { additionalProperties: false },
);

type ReviewParams = Static<typeof autoReviewParameters>;
type PreparedPass = {
  protocol: string;
  run_id: string;
  pass: number;
  passes: number;
  prompt: string;
  prompt_bytes: number;
  prompt_sha256: string;
  model: string | null;
  thinking: string | null;
  max_result_bytes: number;
  admitted_model: boolean;
  engine_timeout_seconds?: number | null;
};

const PYTHON = "/usr/bin/python3";
const MAX_RESULT_BYTES = 2_000_000;
// Code Mode receives details alone; reserve headroom below its default 10 MiB inbox.
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const waitForRequest = `import pathlib,sys,time
p=pathlib.Path(sys.argv[1])
while not p.exists(): time.sleep(0.25)
data=p.read_bytes()
assert len(data)<=4000000, 'Auto Review request exceeds its byte limit'
sys.stdout.buffer.write(data)`;
const submitResponse = `import os,runpy,sys
root=os.path.realpath(sys.argv[1]); script=os.path.realpath(sys.argv[2])
assert os.path.commonpath([root,script])==root
data=sys.stdin.buffer.read(2000001)
assert len(data)<=2000000
with os.fdopen(os.open(sys.argv[-1],os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600),'wb') as f: f.write(data)
sys.argv=sys.argv[2:]
runpy.run_path(script,run_name='__main__')`;
// This process owns the exchange directory through normal exit and cooperative cancellation.
const runReview = `import contextlib,json,os,pathlib,runpy,shutil,signal,sys
root=os.path.realpath(sys.argv[1]); script=os.path.realpath(sys.argv[2]); directory=sys.argv[3]
assert os.path.commonpath([root,script])==root
sys.argv=[script,*sys.argv[4:]]
def stop(signum,frame): raise SystemExit(128+signum)
signal.signal(signal.SIGTERM,stop)
os.mkdir(directory,0o700)
try:
 code=0
 try:
  with contextlib.redirect_stdout(sys.stderr): runpy.run_path(script,run_name='__main__')
 except SystemExit as result:
  code=result.code if isinstance(result.code,int) else 1
  if isinstance(result.code,str): print(result.code,file=sys.stderr)
 def read(name):
  p=pathlib.Path(directory,name)
  if not p.exists(): return b'null'
  with p.open('rb') as f: data=f.read(${MAX_REPORT_BYTES + 1})
  if len(data)>${MAX_REPORT_BYTES}: raise RuntimeError('Auto Review report exceeds 8 MiB; split the review into smaller changes.')
  return data
 payload=b'{"code":'+str(code).encode()+b',"report":'+read('report.json')+b',"status":'+read('status.json')+b'}'
 if len(payload)>${MAX_REPORT_BYTES}: raise RuntimeError('Auto Review report exceeds 8 MiB; split the review into smaller changes.')
 sys.stdout.buffer.write(payload)
 sys.stdout.buffer.flush()
 sys.exit(code)
finally:
 shutil.rmtree(directory)
`;

function helperArgs(params: ReviewParams, directory: string): string[] {
  const args = [
    "--engine",
    "openclaw",
    "--native-handoff",
    `${directory}/handoff`,
    "--json-output",
    `${directory}/report.json`,
    "--status-output",
    `${directory}/status.json`,
  ];
  for (const [flag, value] of [
    ["--model", params.model],
    ["--thinking", params.thinking],
    ["--engine-timeout-seconds", params.timeoutSeconds?.toString()],
    ["--max-review-passes", params.passes?.toString()],
    ["--mode", params.mode],
    ["--base", params.base],
    ["--commit", params.commit],
    ["--max-priority", params.maxPriority],
    ["--prompt", params.prompt],
  ] as const) {
    if (value !== undefined) {
      args.push(flag, value);
    }
  }
  for (const [flag, values] of [
    ["--prompt-file", params.promptFiles],
    ["--dataset", params.datasets],
    ["--source-context", params.sourceContext],
    ["--source-context-file", params.sourceContextFiles],
  ] as const) {
    for (const value of values ?? []) {
      if (path.posix.isAbsolute(value) || value.split("/").includes("..")) {
        throw new Error(`${flag} requires a path inside the current repository.`);
      }
      args.push(flag, value);
    }
  }
  return args;
}

/** Exchange validation binds execution identity; canonical helper alone interprets reviewer output. */
function readPreparedPass(
  raw: string,
  params: ReviewParams,
  pass: number,
  plan?: PreparedPass,
): PreparedPass {
  const request: PreparedPass = JSON.parse(raw);
  if (
    request.protocol !== "autoreview-exec-v1" ||
    typeof request.admitted_model !== "boolean" ||
    !request.admitted_model
  ) {
    throw new Error(
      "Installed Auto Review helper lacks caller model admission; update the Auto Review skill.",
    );
  }
  if (
    request.pass !== pass ||
    !Number.isSafeInteger(request.passes) ||
    request.passes < pass ||
    typeof request.run_id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(request.run_id) ||
    !(request.model === null || typeof request.model === "string") ||
    !(request.thinking === null || typeof request.thinking === "string") ||
    !(
      request.engine_timeout_seconds == null ||
      (Number.isFinite(request.engine_timeout_seconds) && request.engine_timeout_seconds > 0)
    ) ||
    (params.model !== undefined && request.model !== params.model) ||
    (params.thinking !== undefined && request.thinking !== params.thinking) ||
    (plan &&
      (request.run_id !== plan.run_id ||
        request.passes !== plan.passes ||
        request.model !== plan.model ||
        request.thinking !== plan.thinking ||
        (request.engine_timeout_seconds ?? null) !== (plan.engine_timeout_seconds ?? null))) ||
    typeof request.prompt !== "string" ||
    Buffer.byteLength(request.prompt) !== request.prompt_bytes ||
    request.prompt_bytes > 512_000 ||
    createHash("sha256").update(request.prompt).digest("hex") !== request.prompt_sha256 ||
    request.max_result_bytes !== MAX_RESULT_BYTES
  ) {
    throw new Error("Auto Review returned an invalid or substituted prepared pass.");
  }
  return request;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason || (error instanceof Error && error.name === "AbortError"))
  );
}

function clearToolAllowances(byProvider: Record<string, unknown> | undefined) {
  const empty = { allow: [], alsoAllow: [] };
  return {
    ...empty,
    byProvider: Object.fromEntries(
      Object.keys(byProvider ?? {}).map((key): [string, typeof empty] => [key, empty]),
    ),
    sandbox: { tools: empty },
  };
}

type AutoReviewHost = {
  runtime: { system: Pick<OpenClawPluginApi["runtime"]["system"], "runCommandWithTimeout"> };
};

export function createAutoReviewTool(
  api: AutoReviewHost,
  context: OpenClawPluginToolContext<2>,
): AnyAgentTool | null {
  const sandbox = context.sandbox;
  const modelExecution = context.modelExecution;
  const skillRoot = sandbox?.installedSkillRoots.autoreview;
  const assertCompleteResult = context.assertCompleteResult;
  if (!sandbox || !modelExecution || !skillRoot || !assertCompleteResult) {
    return null;
  }
  const helper = `${skillRoot}/scripts/autoreview`;
  const entry = modelExecution.cliEntryPath;
  const python = (
    code: string,
    args: string[],
    signal?: AbortSignal,
    input?: string,
    maxOutputBytes?: number,
  ) => sandbox.run({ argv: [PYTHON, "-I", "-c", code, ...args], input, signal, maxOutputBytes });
  return {
    name: "autoreview",
    label: "Auto Review",
    description:
      "Run the installed Auto Review checkpoint against changes in the current sandbox. The canonical helper supplies review settings; provide only the target and explicitly requested overrides. Returns the complete helper-validated report.",
    parameters: autoReviewParameters,
    async execute(_id, input, signal) {
      if (!Value.Check(autoReviewParameters, input)) {
        throw new Error(
          "Invalid Auto Review arguments. Supply a review target and only explicitly requested overrides.",
        );
      }
      const params = input;
      const operation = new AbortController();
      const callerSignal = signal ? AbortSignal.any([signal, operation.signal]) : operation.signal;
      const directory = `/tmp/openclaw-autoreview-${randomUUID()}`;
      const hostDirectory = await fs.mkdtemp(
        path.join(resolvePreferredOpenClawTmpDir(), "autoreview-"),
      );
      let helperRun: ReturnType<typeof python> | undefined;
      let helperCompleted = false;
      const helperSettled = new AbortController();
      const finishHelper = async () => {
        if (!helperCompleted) {
          operation.abort();
        }
        await helperRun?.catch((error: unknown) => {
          if (!isAbort(error, callerSignal)) {
            throw error;
          }
        });
      };
      const completeResult = (
        completed: Awaited<ReturnType<typeof python>>,
        engineFailure?: string,
      ) => {
        context.assertInvocationCurrent();
        const failureMessage =
          [completed.stderr, engineFailure].filter(Boolean).join("\n") ||
          "Auto Review did not produce a complete validated report.";
        if ((completed.code !== 0 && completed.code !== 1) || !completed.stdout) {
          throw new Error(failureMessage);
        }
        const result: { code: number; report: unknown; status: unknown } = JSON.parse(
          completed.stdout,
        );
        if (result.code !== completed.code || !result.report) {
          throw new Error(failureMessage);
        }
        const details = { report: result.report, status: result.status };
        const text = JSON.stringify(details);
        assertCompleteResult(text);
        return { content: [{ type: "text" as const, text }], details };
      };
      const readRequest = async (pass: number, activeSignal: AbortSignal, plan?: PreparedPass) => {
        const read = await python(
          waitForRequest,
          [`${directory}/handoff/${pass}.request.json`],
          AbortSignal.any([activeSignal, helperSettled.signal]),
        ).catch((error: unknown) => {
          if (!activeSignal.aborted && isAbort(error, helperSettled.signal)) {
            return undefined;
          }
          throw error;
        });
        if (!read) {
          return undefined;
        }
        if (read.code !== 0) {
          throw new Error(read.stderr || "Auto Review request read failed.");
        }
        return readPreparedPass(read.stdout, params, pass, plan);
      };
      try {
        context.assertInvocationCurrent();
        helperRun = python(
          runReview,
          [skillRoot, helper, directory, ...helperArgs(params, directory)],
          callerSignal,
          undefined,
          MAX_REPORT_BYTES,
        );
        void helperRun.then(
          () => {
            helperCompleted = true;
            helperSettled.abort();
          },
          () => {
            helperCompleted = true;
            helperSettled.abort();
          },
        );
        const first = await readRequest(1, callerSignal);
        if (!first) {
          return completeResult(await helperRun);
        }
        return await modelExecution.run(
          { model: first.model, explicit: params.model !== undefined },
          async (scope) => {
            const revoke = () => operation.abort(scope.signal.reason);
            scope.signal.addEventListener("abort", revoke, { once: true });
            try {
              scope.assertCurrent();
              const cwd = path.join(hostDirectory, "workspace");
              await fs.mkdir(cwd, { mode: 0o700 });
              const { resolveAgentConfig } =
                await import("openclaw/plugin-sdk/agent-scope-runtime");
              scope.assertCurrent();
              const config =
                context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? {};
              // A sandbox caller never supplies host configuration or grants host tool access.
              const callerOverride = {
                agents: {
                  defaults: { systemAgent: { agentId: scope.agentId } },
                  entries: {
                    [scope.agentId]: {
                      skills: [],
                      contextInjection: "never",
                      nativeRuntimeConsent: [],
                      model: { primary: scope.model, fallbacks: [] },
                      tools: clearToolAllowances(
                        resolveAgentConfig(config, scope.agentId)?.tools?.byProvider,
                      ),
                    },
                  },
                },
                tools: {
                  ...clearToolAllowances(config.tools?.byProvider),
                  deny: ["*"],
                  toolSearch: false,
                  codeMode: { enabled: false },
                },
              };
              const timeoutSeconds = first.engine_timeout_seconds ?? null;
              let engineFailure: string | undefined;
              for (let pass = 1; pass <= first.passes && !helperSettled.signal.aborted; pass++) {
                scope.assertCurrent();
                const request = pass === 1 ? first : await readRequest(pass, scope.signal, first);
                if (!request) {
                  break;
                }
                const argv = [
                  process.execPath,
                  entry,
                  "agent",
                  "exec",
                  "--json",
                  "--code-mode",
                  "direct",
                  "--message-file",
                  "-",
                  "--config-override",
                  JSON.stringify(callerOverride),
                  "--cwd",
                  cwd,
                ];
                if (params.model !== undefined) {
                  argv.push("--model", scope.model);
                }
                if (first.thinking !== null) {
                  argv.push("--thinking", first.thinking);
                }
                if (timeoutSeconds !== null) {
                  argv.push("--timeout", String(Math.ceil(timeoutSeconds)));
                }
                scope.assertCurrent();
                if (helperSettled.signal.aborted) {
                  break;
                }
                const result = await api.runtime.system
                  .runCommandWithTimeout(argv, {
                    cwd,
                    input: request.prompt,
                    signal: AbortSignal.any([scope.signal, helperSettled.signal]),
                    timeoutMs: timeoutSeconds === null ? undefined : timeoutSeconds * 1000,
                    env: { OPENCLAW_NO_RESPAWN: "1" },
                    outputCapture: "head",
                    maxOutputBytes: { stdout: MAX_RESULT_BYTES, stderr: 64_000 },
                    terminateOnOutputLimit: true,
                    killProcessTree: true,
                    // Native startup must finish its abort cleanup before forced termination.
                    killGraceMs: 5_000,
                    beforeInput: () => {
                      scope.assertCurrent();
                      helperSettled.signal.throwIfAborted();
                    },
                  })
                  .catch((error: unknown) => {
                    if (!scope.signal.aborted && helperSettled.signal.aborted) {
                      return undefined;
                    }
                    throw error;
                  });
                scope.assertCurrent();
                if (!result || helperSettled.signal.aborted) {
                  break;
                }
                const succeeded =
                  result.code === 0 &&
                  result.termination === "exit" &&
                  !result.outputLimitExceeded &&
                  !result.stdoutTruncatedBytes &&
                  result.cleanup !== "uncertain";
                if (!succeeded) {
                  const { redactSensitiveText } = await import("openclaw/plugin-sdk/logging-core");
                  scope.assertCurrent();
                  const detail = redactSensitiveText(result.stderr, { mode: "tools" }).slice(-4096);
                  engineFailure =
                    `Reviewer command failed (exit ${result.code ?? "none"}, ${result.termination}, cleanup ${result.cleanup ?? "unknown"}, output limit ${result.outputLimitExceeded ?? false}, truncated stdout ${result.stdoutTruncatedBytes ?? 0}). ${detail}`.trim();
                }
                const response = JSON.stringify({
                  run_id: request.run_id,
                  pass,
                  prompt_sha256: request.prompt_sha256,
                  status: succeeded ? "done" : "failed",
                  output: succeeded ? result.stdout : null,
                  model: succeeded ? scope.model : null,
                });
                if (Buffer.byteLength(response) > MAX_RESULT_BYTES) {
                  throw new Error(
                    "Auto Review's complete engine result exceeds the exchange limit.",
                  );
                }
                const spool = `${directory}/handoff.${request.run_id}.${pass}.response.json`;
                const submitted = await python(
                  submitResponse,
                  [skillRoot, helper, "--native-submit", `${directory}/handoff`, spool],
                  scope.signal,
                  response,
                );
                if (submitted.code !== 0) {
                  throw new Error(
                    submitted.stderr || "Auto Review rejected the response submission.",
                  );
                }
              }
              const completed = await helperRun!;
              scope.assertCurrent();
              return completeResult(completed, engineFailure);
            } finally {
              try {
                await finishHelper();
              } finally {
                scope.signal.removeEventListener("abort", revoke);
              }
            }
          },
          callerSignal,
        );
      } finally {
        operation.abort();
        try {
          await finishHelper();
        } finally {
          await fs.rm(hostDirectory, { recursive: true, force: true });
        }
      }
    },
  };
}
