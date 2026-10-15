import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const MAX_REVIEW_PASSES = 8;
const MAX_PASS_SECONDS = 600;
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
    model: Type.String({
      minLength: 3,
      description: "Explicit allowed provider/model for the reviewer.",
    }),
    thinking: Type.String({ minLength: 1 }),
    maxPriority: Type.Optional(
      Type.Union(["P0", "P1", "P2", "P3"].map((value) => Type.Literal(value))),
    ),
    passes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_REVIEW_PASSES })),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_PASS_SECONDS })),
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
  model: string;
  thinking: string;
  max_result_bytes: number;
};

const PYTHON = "/usr/bin/python3";
const MAX_RESULT_BYTES = 2_000_000;
// Code Mode receives details alone; reserve headroom below its default 10 MiB inbox.
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const readFile =
  "import pathlib,sys; p=pathlib.Path(sys.argv[1]); data=p.read_bytes() if p.exists() else b''; assert len(data)<=int(sys.argv[2]), 'Auto Review exchange exceeds its byte limit'; sys.stdout.buffer.write(data)";
const writeSpool =
  "import os,sys; data=sys.stdin.buffer.read(2000001); assert len(data)<=2000000; fd=os.open(sys.argv[1],os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); f=os.fdopen(fd,'wb'); f.write(data); f.close()";
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
 except SystemExit as result: code=result.code if isinstance(result.code,int) else 1
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
    "--model",
    params.model,
    "--thinking",
    params.thinking,
    "--engine-timeout-seconds",
    String(params.timeoutSeconds ?? MAX_PASS_SECONDS),
    "--max-review-passes",
    String(params.passes ?? MAX_REVIEW_PASSES),
    "--json-output",
    `${directory}/report.json`,
    "--status-output",
    `${directory}/status.json`,
  ];
  for (const [flag, value] of [
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
function readPreparedPass(raw: string, params: ReviewParams, pass: number): PreparedPass {
  const request: PreparedPass = JSON.parse(raw);
  if (
    request.protocol !== "autoreview-exec-v1" ||
    request.pass !== pass ||
    !Number.isInteger(request.passes) ||
    request.passes < pass ||
    request.passes > (params.passes ?? MAX_REVIEW_PASSES) ||
    typeof request.run_id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(request.run_id) ||
    request.model !== params.model ||
    request.thinking !== params.thinking ||
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
  const runHelper = (args: string[], signal: AbortSignal) =>
    sandbox.run({
      argv: [
        PYTHON,
        "-I",
        "-c",
        "import os,runpy,sys; root=os.path.realpath(sys.argv[1]); script=os.path.realpath(sys.argv[2]); assert os.path.commonpath([root,script])==root; sys.argv=sys.argv[2:]; runpy.run_path(script,run_name='__main__')",
        skillRoot,
        helper,
        ...args,
      ],
      signal,
    });
  return {
    name: "autoreview",
    label: "Auto Review",
    description:
      "Run the installed Auto Review checkpoint against changes in the current sandbox. Uses an explicitly selected reviewer model and returns the helper-validated complete report. No host repository or executable paths are accepted.",
    parameters: autoReviewParameters,
    async execute(_id, input, signal) {
      if (!Value.Check(autoReviewParameters, input)) {
        throw new Error(
          "Invalid Auto Review arguments. Select an explicit model and thinking level, 1–8 passes, and a timeout from 1–600 seconds.",
        );
      }
      const params = input;
      const timeoutSeconds = params.timeoutSeconds ?? MAX_PASS_SECONDS;
      const passes = params.passes ?? MAX_REVIEW_PASSES;
      return modelExecution.run(
        params.model,
        async (scope) => {
          const operation = new AbortController();
          const activeSignal = AbortSignal.any([
            scope.signal,
            operation.signal,
            AbortSignal.timeout(Math.ceil(timeoutSeconds * (passes + 1) * 1000)),
          ]);
          const directory = `/tmp/openclaw-autoreview-${randomUUID()}`;
          const hostDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-autoreview-"));
          let helperRun: ReturnType<typeof runHelper> | undefined;
          try {
            scope.assertCurrent();
            const provider = params.model.slice(0, params.model.indexOf("/"));
            const apiKey = await context.resolveApiKeyForProvider?.(provider);
            scope.assertCurrent();
            if (!apiKey) {
              throw new Error(`No host credential is available for reviewer provider ${provider}.`);
            }
            const model = scope.model;
            const restricted = {
              models: {
                providers: {
                  [provider]: {
                    baseUrl: model.baseUrl,
                    api: model.api,
                    apiKey,
                    headers: model.headers,
                    authHeader: model.authHeader,
                    models: [
                      {
                        id: model.id,
                        name: model.name,
                        reasoning: model.reasoning,
                        thinkingLevelMap: model.thinkingLevelMap,
                        params: model.params,
                        input: model.input,
                        cost: model.cost,
                        contextWindow: model.contextWindow,
                        maxTokens: model.maxTokens,
                        compat: model.compat,
                        agentRuntime: { id: "openclaw" },
                      },
                    ],
                    agentRuntime: { id: "openclaw" },
                  },
                },
              },
              agents: {
                defaults: {
                  model: { primary: params.model, fallbacks: [] },
                  models: { [params.model]: { agentRuntime: { id: "openclaw" } } },
                },
                entries: { main: { skills: [], contextInjection: "never" } },
              },
              tools: { deny: ["*"], codeMode: { enabled: false } },
              plugins: { allow: [] },
              env: { shellEnv: { enabled: false } },
            };
            const configPath = path.join(hostDirectory, "config.json");
            await fs.writeFile(configPath, JSON.stringify(restricted), { mode: 0o600, flag: "wx" });
            const cwd = path.join(hostDirectory, "workspace");
            await fs.mkdir(cwd, { mode: 0o700 });
            const home = path.join(hostDirectory, "home");
            await fs.mkdir(home, { mode: 0o700 });
            scope.assertCurrent();
            let settled = false;
            helperRun = python(
              runReview,
              [skillRoot, helper, directory, ...helperArgs(params, directory)],
              activeSignal,
              undefined,
              MAX_REPORT_BYTES,
            );
            void helperRun.then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              },
            );
            let runId: string | undefined;
            let plannedPasses: number | undefined;
            for (let pass = 1; pass <= passes; pass++) {
              if (settled) {
                break;
              }
              let raw = "";
              while (!raw) {
                if (settled) {
                  break;
                }
                scope.assertCurrent();
                const read = await python(
                  readFile,
                  [`${directory}/handoff/${pass}.request.json`, "4000000"],
                  activeSignal,
                );
                if (read.code !== 0) {
                  throw new Error(read.stderr || "Auto Review request read failed.");
                }
                raw = read.stdout;
                if (!raw && !settled) {
                  await delay(250, undefined, { signal: activeSignal });
                }
              }
              if (!raw) {
                break;
              }
              const request = readPreparedPass(raw, params, pass);
              if (runId && request.run_id !== runId) {
                throw new Error("Auto Review changed exchange ownership.");
              }
              if (plannedPasses !== undefined && request.passes !== plannedPasses) {
                throw new Error("Auto Review changed the granted pass plan.");
              }
              runId = request.run_id;
              plannedPasses = request.passes;
              scope.assertCurrent();
              const result = await api.runtime.system.runCommandWithTimeout(
                [
                  process.execPath,
                  entry,
                  "agent",
                  "exec",
                  "--json",
                  "--message-file",
                  "-",
                  "--config",
                  configPath,
                  "--cwd",
                  cwd,
                  "--model",
                  params.model,
                  "--thinking",
                  params.thinking,
                  "--timeout",
                  String(Math.ceil(timeoutSeconds)),
                ],
                {
                  cwd,
                  input: request.prompt,
                  signal: activeSignal,
                  timeoutMs: timeoutSeconds * 1000,
                  baseEnv: {
                    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
                    HOME: home,
                    USERPROFILE: home,
                    OPENCLAW_HOME: home,
                    OPENCLAW_STATE_DIR: path.join(hostDirectory, "state"),
                    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
                    TMPDIR: hostDirectory,
                    TMP: hostDirectory,
                    TEMP: hostDirectory,
                    OPENCLAW_NO_RESPAWN: "1",
                  },
                  outputCapture: "head",
                  maxOutputBytes: { stdout: MAX_RESULT_BYTES, stderr: 64_000 },
                  terminateOnOutputLimit: true,
                  killProcessTree: true,
                  beforeInput: () => scope.assertCurrent(),
                },
              );
              scope.assertCurrent();
              const succeeded =
                result.code === 0 &&
                result.termination === "exit" &&
                !result.outputLimitExceeded &&
                !result.stdoutTruncatedBytes &&
                result.cleanup !== "uncertain";
              const response = JSON.stringify({
                run_id: request.run_id,
                pass,
                prompt_sha256: request.prompt_sha256,
                status: succeeded ? "done" : "failed",
                output: succeeded ? result.stdout : null,
              });
              if (Buffer.byteLength(response) > MAX_RESULT_BYTES) {
                throw new Error("Auto Review's complete engine result exceeds the exchange limit.");
              }
              const spool = `${directory}/handoff.${request.run_id}.${pass}.response.json`;
              const written = await python(writeSpool, [spool], activeSignal, response);
              if (written.code !== 0) {
                throw new Error(written.stderr || "Auto Review response write failed.");
              }
              const submitted = await runHelper(
                ["--native-submit", `${directory}/handoff`, spool],
                activeSignal,
              );
              if (submitted.code !== 0) {
                throw new Error(
                  submitted.stderr || "Auto Review rejected the response submission.",
                );
              }
            }
            const completed = await helperRun;
            scope.assertCurrent();
            if ((completed.code !== 0 && completed.code !== 1) || !completed.stdout) {
              throw new Error(
                completed.stderr || "Auto Review did not produce a complete validated report.",
              );
            }
            const result: { code: number; report: unknown; status: unknown } = JSON.parse(
              completed.stdout,
            );
            if (result.code !== completed.code || !result.report) {
              throw new Error("Auto Review did not produce a complete validated report.");
            }
            const text = JSON.stringify(result.report);
            assertCompleteResult(text);
            return {
              content: [{ type: "text", text }],
              details: { report: result.report, status: result.status },
            };
          } finally {
            operation.abort();
            try {
              await helperRun?.catch((error: unknown) => {
                if (
                  error !== activeSignal.reason &&
                  !(error instanceof Error && error.name === "AbortError")
                ) {
                  throw error;
                }
              });
            } finally {
              await fs.rm(hostDirectory, { recursive: true, force: true });
            }
          }
        },
        signal,
      );
    },
  };
}
