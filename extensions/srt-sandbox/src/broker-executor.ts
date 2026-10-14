// Read-only health channel for the per-session network control process.
// Commands run under host custody in independent, same-policy sandboxes.
export const BROKER_EXECUTOR_PYTHON = String.raw`
import sys, os, json

def respond(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
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
            respond({"id": rid, "ok": True, "pong": True, "pid": os.getpid(), "executed": 0})
            continue
        if op == "exec":
            respond({"id": rid, "ok": False, "error": "command execution requires host custody"})
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
 * command with the sandbox + proxy env, so the health channel runs under kernel enforcement.
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
