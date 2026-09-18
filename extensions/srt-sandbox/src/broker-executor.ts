// Persistent per-session broker executor (Stage S4-P1, XIN-1936 / Candidate 2).
//
// Design authority: S4 spike verdict (XIN-1932) — "one `srt --control-fd`
// broker process per session". Each `srt` CLI invocation runs its own
// SandboxManager.initialize() (SRT dist/cli.js:189), so it owns a private
// proxy + auth token + allowlist + (Linux) network namespace. That is the
// only place per-session network scope is real: inside a single manager
// process the proxy/token/allowlist are module-level singletons (R3).
//
// This program is the command the broker's `srt -c <cmd>` runs. It is a
// long-lived executor loop that stays INSIDE the broker's sandbox for the
// life of the session, so every command it launches is a descendant of the
// sandboxed shell and therefore inherits the broker's proxy env (baked into
// the wrap by SRT) and, on Linux, its network namespace. That inheritance —
// not a discovered port/token — is what routes a session's traffic through
// its own broker. It speaks a minimal newline-delimited JSON RPC over
// stdin/stdout (the same transport shape as the S3 pin owner):
//
//   ready    -> emitted once at startup so the driver can health-check spawn.
//   exec     -> run {script} via `bash -c`, feed optional {stdin}, honour an
//               optional per-call {timeoutMs}, return {code, stdout, stderr}
//               (stdout/stderr base64 so binary output survives the channel).
//   ping     -> health probe (pid + executed-command counter).
//   shutdown -> clean exit; the broker's srt process then exits too.
//
// Embedded as a shell literal and run via `python3 -c`, mirroring the S3 pin
// owner's GUEST idiom (no separate file to ship). Reads are open under the
// SRT policy, so selecting python3 and executing bash are both permitted; the
// broker's filesystem allowlist still confines any writes the command makes.
export const BROKER_EXECUTOR_PYTHON = String.raw`
import sys, os, json, base64, subprocess

def respond(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def run_exec(req):
    script = req.get("script")
    if not isinstance(script, str):
        return {"ok": False, "error": "exec requires a string script"}
    stdin_b64 = req.get("stdin")
    stdin_bytes = base64.b64decode(stdin_b64) if isinstance(stdin_b64, str) else None
    timeout = req.get("timeoutMs")
    timeout_s = (timeout / 1000.0) if isinstance(timeout, (int, float)) and timeout > 0 else None
    shell = req.get("shell") or "/bin/bash"
    try:
        proc = subprocess.run(
            [shell, "-c", script],
            input=stdin_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired as exc:
        # Fail closed: a wedged command reports a non-zero code and whatever
        # was captured before the deadline, never a hang the driver can't see.
        out = exc.stdout or b""
        err = (exc.stderr or b"") + b"\n[srt-broker] command timed out\n"
        return {
            "ok": True,
            "code": 124,
            "timedOut": True,
            "stdout": base64.b64encode(out).decode("ascii"),
            "stderr": base64.b64encode(err).decode("ascii"),
        }
    return {
        "ok": True,
        "code": proc.returncode,
        "stdout": base64.b64encode(proc.stdout).decode("ascii"),
        "stderr": base64.b64encode(proc.stderr).decode("ascii"),
    }

def main():
    executed = 0
    # Announce readiness so the driver can distinguish a live broker from a
    # spawn that never reached the sandboxed command (fail-closed health-check).
    respond({"ready": True, "pid": os.getpid()})
    for line in sys.stdin:
        line = line.strip()
        if line == "":
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            respond({"id": None, "ok": False, "error": "bad request: " + str(exc)})
            continue
        rid = req.get("id")
        op = req.get("op", "exec")
        if op == "shutdown":
            respond({"id": rid, "ok": True, "result": "bye"})
            break
        if op == "ping":
            respond({"id": rid, "ok": True, "pong": True, "pid": os.getpid(), "executed": executed})
            continue
        if op == "exec":
            try:
                out = run_exec(req)
            except Exception as exc:
                out = {"ok": False, "error": str(exc)}
            executed += 1
            out["id"] = rid
            respond(out)
            continue
        respond({"id": rid, "ok": False, "error": "unknown op: " + str(op)})

main()
`;

/**
 * POSIX python interpreter candidates, in priority order. Mirrors the S3 pin
 * owner's list so the broker executor starts on the same interpreters the
 * approved sandbox path already depends on.
 */
export const BROKER_EXECUTOR_PYTHON_CANDIDATES = [
  "/usr/bin/python3",
  "/usr/local/bin/python3",
  "/opt/homebrew/bin/python3",
  "/bin/python3",
] as const;

/**
 * Build the shell command the broker's `srt -c <cmd>` runs. Selects the first
 * available python3 (fail-closed with exit 127 if none), then execs it on the
 * embedded executor with stdin/stdout as the RPC channel. `srt` wraps this
 * command with the sandbox + proxy env, so the executor and every command it
 * spawns run under the broker's kernel enforcement and network scope.
 */
export function buildBrokerExecutorCommand(): string {
  const literal = `'${BROKER_EXECUTOR_PYTHON.replaceAll("'", `'\\''`)}'`;
  return [
    "set -eu",
    "python_cmd=''",
    ...BROKER_EXECUTOR_PYTHON_CANDIDATES.map(
      (candidate) =>
        `if [ -z "$python_cmd" ] && [ -x '${candidate}' ]; then python_cmd='${candidate}'; fi`,
    ),
    'if [ -z "$python_cmd" ]; then python_cmd=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true); fi',
    'if [ -z "$python_cmd" ]; then',
    "  echo >&2 'srt-sandbox broker executor requires python3 or python'",
    "  exit 127",
    "fi",
    `broker_script=${literal}`,
    'exec "$python_cmd" -c "$broker_script"',
  ].join("\n");
}
