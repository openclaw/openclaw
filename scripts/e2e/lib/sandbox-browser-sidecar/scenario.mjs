import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

const root = requireEnv("OPENCLAW_E2E_ROOT");
const hostRoot = requireEnv("OPENCLAW_E2E_HOST_ROOT");
const workspaceAccess = requireEnv("OPENCLAW_E2E_WORKSPACE_ACCESS");
assert.notEqual(root, hostRoot, "DooD proof requires different Gateway and daemon paths");
assert(["none", "ro", "rw"].includes(workspaceAccess));
const sandboxImage = requireEnv("OPENCLAW_E2E_SANDBOX_IMAGE");
const browserImage = requireEnv("OPENCLAW_E2E_BROWSER_IMAGE");
const sandboxPrefix = requireEnv("OPENCLAW_E2E_SANDBOX_PREFIX");
const browserPrefix = requireEnv("OPENCLAW_E2E_BROWSER_PREFIX");
const browserNetwork = requireEnv("OPENCLAW_E2E_BROWSER_NETWORK");
const stateDir = path.join(root, "state");
const workspaceDir = path.join(root, "workspace");
const sandboxRoot = path.join(root, "sandboxes");
const configPath = path.join(stateDir, "openclaw.json");
const sessionKey = requireEnv("OPENCLAW_E2E_SESSION_KEY");
const workspaceHash = createHash("sha256").update(workspaceDir).digest("hex").slice(0, 32);
const scopeKey = `${sessionKey}:workspace:${workspaceHash}`;
const browserToken = `sandbox-browser-sidecar-${process.pid}`;
const marker = `OPENCLAW_SANDBOX_BROWSER_SIDECAR_${process.pid}`;
const ownedContainerNames = new Set();

process.env.HOME = path.join(root, "home");
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = configPath;
// Sandbox state roots are process-stable; initialize them from the fixture's
// environment before loading the packaged runtime.
const { resolveSandboxContext } = await import("openclaw/plugin-sdk/agent-harness-runtime");

const config = {
  skills: { load: { extraDirs: [path.join(root, "skill-source")] } },
  gateway: {
    auth: {
      mode: "token",
      token: browserToken,
    },
  },
  browser: {
    enabled: true,
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: true,
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: ["browser"],
      },
    },
  },
  agents: {
    defaults: {
      workspace: workspaceDir,
      sandbox: {
        mode: "all",
        backend: "docker",
        scope: "session",
        workspaceAccess,
        workspaceRoot: sandboxRoot,
        docker: {
          image: sandboxImage,
          containerPrefix: sandboxPrefix,
          network: "none",
          extraHosts: ["host.docker.internal:host-gateway"],
        },
        browser: {
          enabled: true,
          image: browserImage,
          containerPrefix: browserPrefix,
          network: browserNetwork,
          headless: true,
          noVncEnabled: false,
          autoStart: true,
          autoStartTimeoutMs: 120_000,
        },
      },
    },
  },
};

async function run(command, args, options = {}) {
  return await execFileAsync(command, args, {
    cwd: "/app",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

async function docker(args, options) {
  return await run("docker", args, options);
}

async function fileOwnership(filePath) {
  const { uid, gid, mode } = await fs.stat(filePath);
  return { uid, gid, mode: mode & 0o777 };
}

async function listTaskContainers() {
  // Container names can shorten the configured prefix; the scope label stays exact.
  const { stdout } = await docker([
    "ps",
    "-a",
    "--filter",
    `label=openclaw.sessionKey=${scopeKey}`,
    "--format",
    "{{.Names}}",
  ]);
  return stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function cleanupTaskResources() {
  const names = new Set([...ownedContainerNames, ...(await listTaskContainers().catch(() => []))]);
  for (const name of names) {
    await docker(["rm", "-f", name]).catch(() => undefined);
  }
  await docker(["network", "rm", browserNetwork]).catch(() => undefined);
}

function requestJson(baseUrl, requestPath, init = {}) {
  return fetch(`${baseUrl}${requestPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${browserToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  }).then(async (response) => {
    const text = await response.text();
    assert.equal(response.ok, true, `${requestPath} failed (${response.status}): ${text}`);
    return text ? JSON.parse(text) : {};
  });
}

async function startFixtureServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body><main><h1>${marker}</h1></main></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "fixture server did not bind a TCP port");
  return {
    server,
    port: address.port,
  };
}

const gatewayIdentity = { uid: process.geteuid(), gid: process.getegid() };
const fixtureOwnership = {
  gateway: gatewayIdentity,
  workspace: await fileOwnership(workspaceDir),
  nestedData: await fileOwnership(path.join(root, "nested data")),
};
process.stdout.write(
  `${JSON.stringify({ stage: "fixture-ownership", workspaceAccess, ...fixtureOwnership })}\n`,
);
assert.notEqual(gatewayIdentity.uid, 0, "Gateway fixture must use the image's non-root user");
for (const { uid, gid, mode } of [fixtureOwnership.workspace, fixtureOwnership.nestedData]) {
  assert.deepEqual({ uid, gid }, gatewayIdentity, "bind source owner differs from Gateway user");
  assert.equal(mode, 0o755, "bind source permissions must not mask ownership mismatches");
}

await fs.mkdir(process.env.HOME, { recursive: true });
await fs.mkdir(stateDir, { recursive: true });
await fs.writeFile(path.join(workspaceDir, "USER.md"), marker);
await fs.writeFile(path.join(root, "nested data", "proof.txt"), marker);
await fs.mkdir(path.join(root, "skill-source", "mount-proof"), { recursive: true });
await fs.writeFile(
  path.join(root, "skill-source", "mount-proof", "SKILL.md"),
  `---\nname: mount-proof\ndescription: deterministic sandbox mount proof\n---\n${marker}\n`,
);
await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const fixture = await startFixtureServer();

try {
  const params = {
    config,
    agentId: "main",
    sessionKey,
    workspaceDir,
  };
  const [first, second] = await Promise.all([
    resolveSandboxContext(params),
    resolveSandboxContext(params),
  ]);

  assert(first, "first sandbox context was not provisioned");
  assert(second, "second sandbox context was not provisioned");
  assert(first.browser, "first sandbox browser context was not provisioned");
  assert(second.browser, "second sandbox browser context was not provisioned");
  assert.equal(first.containerName, second.containerName, "concurrent calls split sandbox runtime");
  assert.equal(
    first.browser.containerName,
    second.browser.containerName,
    "concurrent calls split browser runtime",
  );
  assert.equal(
    first.browser.bridgeUrl,
    second.browser.bridgeUrl,
    "concurrent calls split browser bridge",
  );
  const { stdout: gatewayStdout } = await docker([
    "network",
    "inspect",
    "-f",
    "{{(index .IPAM.Config 0).Gateway}}",
    browserNetwork,
  ]);
  const gateway = gatewayStdout.trim();
  assert(gateway, "browser Docker network did not report a gateway");
  const fixtureUrl = `http://${gateway}:${fixture.port}/`;
  ownedContainerNames.add(first.containerName);
  ownedContainerNames.add(first.browser.containerName);

  const skillPath =
    workspaceAccess === "rw"
      ? "/workspace/.openclaw/sandbox-skills/skills/mount-proof/SKILL.md"
      : "/workspace/skills/mount-proof/SKILL.md";
  const nestedPath =
    workspaceAccess === "none"
      ? undefined
      : `${workspaceAccess === "ro" ? "/agent" : "/workspace"}/data/proof.txt`;
  for (const filePath of ["/workspace/USER.md", skillPath, ...(nestedPath ? [nestedPath] : [])]) {
    assert.match((await first.fsBridge.readFile({ filePath })).toString(), new RegExp(marker));
    const read = await first.backend.runShellCommand({ script: 'cat "$1"', args: [filePath] });
    assert.match(
      read.stdout.toString(),
      new RegExp(marker),
      "sandbox exec disagrees with Gateway file tools",
    );
    const browserRead = await docker([
      "exec",
      first.browser.containerName,
      "/bin/sh",
      "-c",
      'cat "$1"',
      "--",
      filePath,
    ]);
    assert.match(browserRead.stdout, new RegExp(marker), "browser mount exposes different bytes");
  }
  const write = { filePath: "/workspace/roundtrip.txt", data: marker };
  if (workspaceAccess === "ro") {
    await assert.rejects(first.fsBridge.writeFile(write));
    const attempted = await first.backend.runShellCommand({
      script: 'printf %s "$2" > "$1"',
      args: [write.filePath, marker],
      allowFailure: true,
    });
    assert.notEqual(attempted.code, 0, "read-only workspace accepted an exec write");
  } else {
    await first.fsBridge.writeFile(write);
    const read = await first.backend.runShellCommand({
      script: 'cat "$1"',
      args: [write.filePath],
    });
    assert.equal(read.stdout.toString(), marker);
    await first.backend.runShellCommand({
      script: 'printf %s "$2" > "$1"',
      args: [write.filePath, `${marker}-exec`],
    });
    if (workspaceAccess === "rw") {
      const { stdout } = await docker([
        "inspect",
        "--format",
        "{{.Config.User}}",
        first.containerName,
      ]);
      const sandboxUser = stdout.trim();
      const roundtrip = await fileOwnership(path.join(workspaceDir, "roundtrip.txt"));
      process.stdout.write(
        `${JSON.stringify({ stage: "roundtrip-ownership", workspaceAccess, sandboxUser, roundtrip })}\n`,
      );
      assert.equal(sandboxUser, `${gatewayIdentity.uid}:${gatewayIdentity.gid}`);
      assert.deepEqual({ uid: roundtrip.uid, gid: roundtrip.gid }, gatewayIdentity);
      assert.equal(roundtrip.mode, 0o600, "roundtrip must remain private to its owner");
    }
    assert.equal(
      (await first.fsBridge.readFile({ filePath: write.filePath })).toString(),
      `${marker}-exec`,
    );
  }
  for (const filePath of [skillPath, ...(nestedPath ? [nestedPath] : [])]) {
    await assert.rejects(first.fsBridge.writeFile({ filePath, data: "must-not-write" }));
    const attempted = await first.backend.runShellCommand({
      script: 'printf x > "$1"',
      args: [filePath],
      allowFailure: true,
    });
    assert.notEqual(attempted.code, 0, "read-only skill or nested Gateway mount accepted a write");
  }
  const mountProof = [];
  for (const containerName of [first.containerName, first.browser.containerName]) {
    const { stdout } = await docker(["inspect", "--format", "{{json .Mounts}}", containerName]);
    const managed = JSON.parse(stdout).filter(
      (mount) =>
        mount.Destination === "/agent" ||
        mount.Destination.startsWith("/agent/") ||
        mount.Destination === "/workspace" ||
        mount.Destination.startsWith("/workspace/"),
    );
    assert(managed.length > 0);
    assert.equal(
      managed.some((mount) => mount.Destination === "/agent"),
      workspaceAccess === "ro",
    );
    for (const mount of managed) {
      assert.equal(mount.Type, "bind");
      assert(
        mount.Source.startsWith(`${hostRoot}/`),
        "sandbox source was not translated into the daemon namespace",
      );
    }
    mountProof.push(
      managed
        .map((mount) => ({
          source: path.relative(hostRoot, mount.Source),
          destination: mount.Destination,
          writable: mount.RW,
        }))
        .toSorted((a, b) =>
          a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0,
        ),
    );
  }
  assert.deepEqual(mountProof[0], mountProof[1], "shell/browser managed mount plans differ");

  const unauthenticated = await fetch(`${first.browser.bridgeUrl}/`);
  assert.equal(unauthenticated.status, 401, "browser bridge accepted an unauthenticated request");
  await unauthenticated.body?.cancel();

  const opened = await requestJson(first.browser.bridgeUrl, "/tabs/open", {
    method: "POST",
    body: JSON.stringify({ url: fixtureUrl }),
  });
  assert.equal(typeof opened.targetId, "string", "bridge did not return an opened tab");

  const snapshot = await requestJson(
    first.browser.bridgeUrl,
    `/snapshot?format=ai&targetId=${encodeURIComponent(opened.targetId)}`,
  );
  assert.equal(snapshot.format, "ai", "bridge returned the wrong snapshot format");
  assert.match(snapshot.snapshot, new RegExp(marker), "snapshot did not contain the HTML marker");

  const { stdout: listStdout } = await run("openclaw", ["sandbox", "list", "--browser", "--json"]);
  const listed = JSON.parse(listStdout);
  const browserEntry = listed.browsers?.find(
    (entry) => entry.containerName === first.browser.containerName,
  );
  assert(browserEntry, "packaged sandbox list did not report the browser container");
  assert.equal(browserEntry.sessionKey, scopeKey);
  assert.equal(browserEntry.running, true);

  await run("openclaw", [
    "sandbox",
    "recreate",
    "--browser",
    "--session",
    browserEntry.sessionKey,
    "--force",
  ]);
  const remaining = await listTaskContainers();
  assert(
    !remaining.includes(first.browser.containerName),
    "packaged recreate kept browser container",
  );
  assert(remaining.includes(first.containerName), "packaged recreate removed normal sandbox");

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      workspaceAccess,
      managedMounts: mountProof,
      sandboxContainer: first.containerName,
      browserContainer: first.browser.containerName,
      marker,
    })}\n`,
  );
} finally {
  await new Promise((resolve) => {
    fixture.server.close(resolve);
  });
  await cleanupTaskResources();
}

// resolveSandboxContext owns an in-process bridge server that intentionally
// stays live for agent reuse. This standalone scenario has finished its cleanup.
process.exit(0);
