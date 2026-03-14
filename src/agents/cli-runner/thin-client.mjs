#!/usr/bin/env node

// ------------------------------------------------------------------
// OpenClaw-Tool Thin Client (Agent RPC Probe)
// This script runs inside the Agent's sandbox bash environment.
// It forwards arguments and piped stdin to the OpenClaw Daemon.
// ------------------------------------------------------------------

const port = process.env.OPENCLAW_RPC_PORT;
const sessionKey = process.env.OPENCLAW_INTERNAL_SESSION;

if (!port) {
  console.error("Error: openclaw-tool requires OPENCLAW_RPC_PORT environment variable.");
  console.error("Are you running this outside of an OpenClaw Agent session?");
  process.exit(1);
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    const timer = setTimeout(() => resolve(data), 500);
    process.stdin.on("data", () => timer.refresh());
  });
}

async function main() {
  const args = process.argv.slice(2);
  const stdinData = await readStdin();

  let host = "127.0.0.1";
  if (process.env.OPENCLAW_GATEWAY_URL) {
    try {
      host = new URL(process.env.OPENCLAW_GATEWAY_URL).hostname;
    } catch {
      // Ignored
    }
  } else if (process.env.PI_IS_SANDBOX) {
    host = "host.docker.internal";
  }

  let res;
  try {
    try {
      res = await fetch(`http://${host}:${port}/rpc/openclaw-tool`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenClaw-Session": sessionKey || "",
        },
        body: JSON.stringify({ args, stdin: stdinData, cwd: process.cwd() }),
      });
    } catch (err) {
      if (host !== "172.17.0.1") {
        try {
          res = await fetch(`http://172.17.0.1:${port}/rpc/openclaw-tool`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-OpenClaw-Session": sessionKey || "",
            },
            body: JSON.stringify({ args, stdin: stdinData, cwd: process.cwd() }),
          });
        } catch {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`openclaw-tool daemon returned invalid JSON: ${text.substring(0, 100)}...`);
      process.exit(1);
    }

    if (data.stdout) {
      process.stdout.write(data.stdout);
    }
    if (data.stderr) {
      process.stderr.write(data.stderr);
    }

    process.exit(data.exitCode ?? (res.ok ? 0 : 1));
  } catch (err) {
    console.error(`openclaw-tool communication error: ${err.message}`);
    console.error(`Make sure the OpenClaw Daemon is listening on port ${port}.`);
    process.exit(1);
  }
}

main().catch(console.error);
