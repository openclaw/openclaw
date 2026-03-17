import { spawn } from "node:child_process";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveWindowsLobsterSpawn } from "./windows-spawn.js";
function normalizeForCwdSandbox(p) {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function resolveCwd(cwdRaw) {
  if (typeof cwdRaw !== "string" || !cwdRaw.trim()) {
    return process.cwd();
  }
  const cwd = cwdRaw.trim();
  if (path.isAbsolute(cwd)) {
    throw new Error("cwd must be a relative path");
  }
  const base = process.cwd();
  const resolved = path.resolve(base, cwd);
  const rel = path.relative(normalizeForCwdSandbox(base), normalizeForCwdSandbox(resolved));
  if (rel === "" || rel === ".") {
    return resolved;
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("cwd must stay within the gateway working directory");
  }
  return resolved;
}
async function runLobsterSubprocessOnce(params) {
  const { execPath, argv, cwd } = params;
  const timeoutMs = Math.max(200, params.timeoutMs);
  const maxStdoutBytes = Math.max(1024, params.maxStdoutBytes);
  const env = { ...process.env, LOBSTER_MODE: "tool" };
  const nodeOptions = env.NODE_OPTIONS ?? "";
  if (nodeOptions.includes("--inspect")) {
    delete env.NODE_OPTIONS;
  }
  const spawnTarget = process.platform === "win32" ? resolveWindowsLobsterSpawn(execPath, argv, env) : { command: execPath, argv };
  return await new Promise((resolve, reject) => {
    const child = spawn(spawnTarget.command, spawnTarget.argv, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: spawnTarget.windowsHide
    });
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (result.ok) {
        resolve(result.value);
      } else {
        reject(result.error);
      }
    };
    const failAndTerminate = (message) => {
      try {
        child.kill("SIGKILL");
      } finally {
        settle({ ok: false, error: new Error(message) });
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      const str = String(chunk);
      stdoutBytes += Buffer.byteLength(str, "utf8");
      if (stdoutBytes > maxStdoutBytes) {
        failAndTerminate("lobster output exceeded maxStdoutBytes");
        return;
      }
      stdout += str;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      failAndTerminate("lobster subprocess timed out");
    }, timeoutMs);
    child.once("error", (err) => {
      settle({ ok: false, error: err });
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        settle({
          ok: false,
          error: new Error(`lobster failed (${code ?? "?"}): ${stderr.trim() || stdout.trim()}`)
        });
        return;
      }
      settle({ ok: true, value: { stdout } });
    });
  });
}
function parseEnvelope(stdout) {
  const trimmed = stdout.trim();
  const tryParse = (input) => {
    try {
      return JSON.parse(input);
    } catch {
      return void 0;
    }
  };
  let parsed = tryParse(trimmed);
  if (parsed === void 0) {
    const suffixMatch = trimmed.match(/({[\s\S]*}|\[[\s\S]*])\s*$/);
    if (suffixMatch?.[1]) {
      parsed = tryParse(suffixMatch[1]);
    }
  }
  if (parsed === void 0) {
    throw new Error("lobster returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("lobster returned invalid JSON envelope");
  }
  const ok = parsed.ok;
  if (ok === true || ok === false) {
    return parsed;
  }
  throw new Error("lobster returned invalid JSON envelope");
}
function buildLobsterArgv(action, params) {
  if (action === "run") {
    const pipeline = typeof params.pipeline === "string" ? params.pipeline : "";
    if (!pipeline.trim()) {
      throw new Error("pipeline required");
    }
    const argv = ["run", "--mode", "tool", pipeline];
    const argsJson = typeof params.argsJson === "string" ? params.argsJson : "";
    if (argsJson.trim()) {
      argv.push("--args-json", argsJson);
    }
    return argv;
  }
  if (action === "resume") {
    const token = typeof params.token === "string" ? params.token : "";
    if (!token.trim()) {
      throw new Error("token required");
    }
    const approve = params.approve;
    if (typeof approve !== "boolean") {
      throw new Error("approve required");
    }
    return ["resume", "--token", token, "--approve", approve ? "yes" : "no"];
  }
  throw new Error(`Unknown action: ${action}`);
}
function createLobsterTool(api) {
  return {
    name: "lobster",
    label: "Lobster Workflow",
    description: "Run Lobster pipelines as a local-first workflow runtime (typed JSON envelope + resumable approvals).",
    parameters: Type.Object({
      // NOTE: Prefer string enums in tool schemas; some providers reject unions/anyOf.
      action: Type.Unsafe({ type: "string", enum: ["run", "resume"] }),
      pipeline: Type.Optional(Type.String()),
      argsJson: Type.Optional(Type.String()),
      token: Type.Optional(Type.String()),
      approve: Type.Optional(Type.Boolean()),
      cwd: Type.Optional(
        Type.String({
          description: "Relative working directory (optional). Must stay within the gateway working directory."
        })
      ),
      timeoutMs: Type.Optional(Type.Number()),
      maxStdoutBytes: Type.Optional(Type.Number())
    }),
    async execute(_id, params) {
      const action = typeof params.action === "string" ? params.action.trim() : "";
      if (!action) {
        throw new Error("action required");
      }
      const execPath = "lobster";
      const cwd = resolveCwd(params.cwd);
      const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 2e4;
      const maxStdoutBytes = typeof params.maxStdoutBytes === "number" ? params.maxStdoutBytes : 512e3;
      const argv = buildLobsterArgv(action, params);
      if (api.runtime?.version && api.logger?.debug) {
        api.logger.debug(`lobster plugin runtime=${api.runtime.version}`);
      }
      const { stdout } = await runLobsterSubprocessOnce({
        execPath,
        argv,
        cwd,
        timeoutMs,
        maxStdoutBytes
      });
      const envelope = parseEnvelope(stdout);
      return {
        content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
        details: envelope
      };
    }
  };
}
export {
  createLobsterTool
};
