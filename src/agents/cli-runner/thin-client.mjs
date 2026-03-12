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
  // If running in a TTY (interactive terminal), don't block waiting for stdin.
  if (process.stdin.isTTY) {
    return "";
  }
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));

    // Safety timeout: if stdin stays open without data for 500ms, assume done.
    // In a real implementation, we might want to handle this differently,
    // but this prevents the daemon probe from hanging indefinitely.
    const timer = setTimeout(() => resolve(data), 500);
    process.stdin.on("data", () => timer.refresh());
  });
}

async function main() {
  const args = process.argv.slice(2);
  const stdinData = await readStdin();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/rpc/openclaw-tool`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenClaw-Session": sessionKey || "",
      },
      body: JSON.stringify({
        args,
        stdin: stdinData,
        cwd: process.cwd(),
      }),
    });

    // Parse the response from the daemon
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`openclaw-tool daemon returned invalid JSON: ${text.substring(0, 100)}...`);
      process.exit(1);
    }

    // Forward the outputs transparently to the bash environment
    if (data.stdout) {
      process.stdout.write(data.stdout);
    }
    if (data.stderr) {
      process.stderr.write(data.stderr);
    }

    // Exit with the code instructed by the daemon
    process.exit(data.exitCode ?? (res.ok ? 0 : 1));
  } catch (err) {
    console.error(`openclaw-tool communication error: ${err.message}`);
    console.error(`Make sure the OpenClaw Daemon is listening on port ${port}.`);
    process.exit(1);
  }
}

main().catch(console.error);
