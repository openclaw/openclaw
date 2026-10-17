import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.env.OPENCLAW_MCP_CUSTODY_ROOT;
const runId = process.env.OPENCLAW_MCP_CUSTODY_RUN_ID;
const image = process.env.OPENCLAW_MCP_CUSTODY_IMAGE;
assert(root && runId && image, "Docker custody fixture environment is required");

async function docker(args) {
  const result = await execFileAsync("docker", args, { encoding: "utf8" });
  return result.stdout.trim();
}

async function waitForReady(directory, cli) {
  let changed;
  /** @type {Error | undefined} */
  let watchFailure;
  const watcher = watch(directory, () => changed?.());
  watcher.on("error", (error) => {
    watchFailure = error;
    changed?.();
  });
  try {
    while (true) {
      const event = new Promise((resolve) => {
        changed = resolve;
      });
      if (watchFailure) {
        throw watchFailure;
      }
      try {
        return await fs.readFile(path.join(directory, "ready"), "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      await Promise.race([
        event,
        cli.done.then((result) => {
          throw new Error(`CLI exited before fixture readiness: ${JSON.stringify(result)}`);
        }),
      ]);
    }
  } finally {
    watcher.close();
  }
}

function startMcpCommand(stateDir, args) {
  const child = spawn(
    process.execPath,
    ["/app/openclaw.mjs", "--profile", "docker-custody", "mcp", ...args],
    {
      cwd: "/app",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        // Keep this exact child as the state owner for the SIGKILL recovery case.
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

async function exercise(mode) {
  const directory = path.join(root, mode);
  const stateDir = path.join(directory, "state");
  await fs.mkdir(stateDir, { recursive: true });
  const name = `mcp-custody-${runId}-${mode}`;
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--label",
    `openclaw.test.mcp-custody=${runId}`,
    "--volume",
    `${directory}:/proof`,
    "--volume",
    `${root}/server.cjs:/server.cjs:ro`,
    "--env",
    `MCP_CUSTODY_MODE=${mode}`,
    image,
    "node",
    "/server.cjs",
  ];
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const server =
    mode === "shell-close"
      ? { command: "sh", args: ["-c", `exec docker ${args.map(quote).join(" ")}`] }
      : { command: mode === "close" ? "/usr/bin/docker" : "docker", args };
  await fs.writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      agents: { defaults: { workspace: path.join(directory, "workspace") } },
      plugins: { enabled: false },
      mcp: {
        servers:
          mode === "add"
            ? {}
            : {
                fixture: {
                  ...server,
                  transport: "stdio",
                  ...(mode === "configure" ? { enabled: false } : {}),
                },
              },
      },
    }),
  );
  const commandArgs =
    mode === "add"
      ? ["add", "fixture", "--command", server.command, ...server.args.map((arg) => `--arg=${arg}`)]
      : mode === "configure"
        ? ["configure", "fixture", "--enable", "--parallel", "--probe"]
        : ["probe", "fixture", "--json"];
  const before = await docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${name}$`]);
  assert.equal(before, "", "fixture name must not predate this launch");
  const startedAt = performance.now();
  let cli = startMcpCommand(stateDir, commandArgs);
  try {
    const ready = await waitForReady(directory, cli);
    assert.equal(ready, mode === "timeout" ? "initialize-withheld" : "tools/list");
    const [container] = JSON.parse(await docker(["inspect", "--type", "container", name]));
    let id = container.Id;
    assert.match(id, /^[a-f0-9]{64}$/u);
    assert.equal(container.State.Running, true, "real Docker fixture must be running");
    let labels = container.Config.Labels;
    let recoveredFrom;
    let unrelatedId;
    if (mode === "recovery") {
      assert.equal(JSON.parse(labels["openclaw.mcp.gateway"]).process.pid, cli.child.pid);
      unrelatedId = await docker([
        "run",
        "--detach",
        "--rm",
        "--name",
        `${name}-unrelated`,
        "--label",
        `openclaw.test.mcp-custody=${runId}`,
        image,
        "node",
        "-e",
        "setInterval(() => {}, 1000)",
      ]);
      assert.match(unrelatedId, /^[a-f0-9]{64}$/u);
      const [unrelated] = JSON.parse(await docker(["inspect", "--type", "container", unrelatedId]));
      assert.equal(unrelated.Config.Labels["openclaw.mcp.state"], undefined);
      assert.equal(unrelated.State.Running, true);
      assert(cli.child.kill("SIGKILL"), "the exact state-owning CLI must receive SIGKILL");
      const killed = await cli.done;
      assert.equal(killed.signal, "SIGKILL", JSON.stringify(killed));
      assert.equal(
        await docker(["ps", "-aq", "--no-trunc", "--filter", `id=${id}`]),
        id,
        "SIGKILL must leave a real owned container for restart recovery",
      );
      await fs.rm(path.join(directory, "ready"));
      recoveredFrom = id;
      cli = startMcpCommand(stateDir, commandArgs);
      assert.equal(await waitForReady(directory, cli), "tools/list");
      const [replacement] = JSON.parse(await docker(["inspect", "--type", "container", name]));
      id = replacement.Id;
      labels = replacement.Config.Labels;
      assert.notEqual(id, recoveredFrom, "same-state restart must launch a fresh container");
      assert.equal(replacement.State.Running, true);
      assert.equal(
        await docker(["ps", "-aq", "--no-trunc", "--filter", `id=${recoveredFrom}`]),
        "",
        "restart recovery must remove the old exact ID before admitting its replacement",
      );
      const [retained] = JSON.parse(await docker(["inspect", "--type", "container", unrelatedId]));
      assert.equal(retained.State.Running, true, "recovery must preserve the unrelated container");
    }
    if (mode !== "timeout") {
      await fs.writeFile(path.join(directory, "release"), "release");
    }
    const result = await cli.done;
    assert.doesNotMatch(result.stderr, /cleanup is unconfirmed/iu);
    assert.equal(result.signal, null, JSON.stringify(result));
    if (mode === "timeout") {
      assert.notEqual(
        result.code,
        0,
        "withheld initialize must fail at the default connection deadline",
      );
      assert.match(`${result.stdout}\n${result.stderr}`, /timed out/iu);
    } else {
      assert.equal(result.code, 0, JSON.stringify(result));
      const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert(requests.some((entry) => entry.method === "initialize"));
      assert(requests.some((entry) => entry.method === "tools/list"));
      if (recoveredFrom) {
        assert.equal(requests.filter((entry) => entry.method === "initialize").length, 2);
        assert.equal(requests.filter((entry) => entry.method === "tools/list").length, 2);
      }
    }
    // Successful Docker enumeration is required: daemon errors must not be
    // mistaken for absence. Include stopped/Created containers, not just live ones.
    assert.equal(
      await docker(["ps", "-aq", "--no-trunc", "--filter", `id=${id}`]),
      "",
      "CLI settlement must remove its exact container",
    );
    assert(labels["openclaw.mcp.state"], "transport must label its state namespace");
    assert(labels["openclaw.mcp.gateway"], "transport must record its owner");
    assert(labels["openclaw.mcp.launch"], "transport must label the launch");
    if (mode === "add" || mode === "configure") {
      const savedConfig = JSON.parse(
        await fs.readFile(path.join(stateDir, "openclaw.json"), "utf8"),
      );
      const saved = savedConfig.mcp.servers.fixture;
      assert(saved, "successful pre-save probe must persist the server");
      assert.equal(saved.command, server.command);
      assert.deepEqual(
        saved.args,
        server.args,
        "custody flags must never be saved in operator config",
      );
      assert.notEqual(saved.enabled, false, "the saved server must be enabled");
      assert.equal(
        saved.connectionTimeoutMs,
        undefined,
        "the pre-save probe deadline must remain transient",
      );
      if (mode === "configure") {
        assert.equal(saved.supportsParallelToolCalls, true);
      }
    }
    if (unrelatedId) {
      const [retained] = JSON.parse(await docker(["inspect", "--type", "container", unrelatedId]));
      assert.equal(
        retained.State.Running,
        true,
        "normal cleanup must also preserve the unrelated container",
      );
    }
    console.log(
      JSON.stringify({
        mode,
        containerId: id,
        elapsedMs: Math.round(performance.now() - startedAt),
        exitCode: result.code,
        removed: true,
        ...(mode === "add" || mode === "configure" ? { saved: true } : {}),
        ...(recoveredFrom ? { recoveredFrom, unrelatedId, unrelatedRetained: true } : {}),
      }),
    );
  } finally {
    if (cli.child.exitCode === null && cli.child.signalCode === null) {
      cli.child.kill("SIGKILL");
    }
    await cli.done;
  }
}

try {
  for (const mode of ["close", "add", "configure", "timeout", "shell-close", "recovery"]) {
    await exercise(mode);
  }
  console.log("Docker MCP custody CLI proof passed");
} finally {
  const remaining = await docker([
    "ps",
    "-aq",
    "--no-trunc",
    "--filter",
    `label=openclaw.test.mcp-custody=${runId}`,
  ]);
  for (const id of remaining.split("\n").filter(Boolean)) {
    await docker(["rm", "--force", id]);
  }
}
