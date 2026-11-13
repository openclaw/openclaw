import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export async function createHarness() {
  const packageDir = process.argv[2];
  const require = createRequire(path.join(packageDir, "package.json"));
  const { GatewayClient } = await import(
    pathToFileURL(require.resolve("openclaw/plugin-sdk/gateway-runtime"))
  );
  const root = "/tmp/muse-proof";
  fs.mkdirSync(root, { recursive: true });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const token = randomUUID();
  Object.assign(config, {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: 18789,
      auth: { mode: "token", token },
      controlUi: { enabled: false },
    },
    agents: {
      defaults: {
        workspace,
        model: "meta/muse-spark-1.3",
        models: { "meta/muse-spark-1.3": { agentRuntime: { id: "muse" } } },
      },
    },
    tools: { exec: { security: "full", ask: "on-miss" } },
    browser: { enabled: false },
    update: { checkOnStart: false },
  });
  const saveConfig = () => fs.writeFileSync(configPath, JSON.stringify(config));
  const gatewayLog = () => fs.readFileSync(path.join(root, "gateway.log"), "utf8");
  saveConfig();
  let child;
  let client;
  let activeApprovals;
  let activeDecision;
  let approvalFailure;
  let activeAfterApproval;
  let activeBeforeApproval;
  let activeResolutions = [];
  let activeRunId;
  async function stop() {
    client?.stop();
    client = undefined;
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      process.kill(-child.pid, "SIGTERM");
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 10000);
      await exited;
      clearTimeout(timer);
    }
    child = undefined;
  }
  const sessionKey = "agent:main:muse-docker-proof";
  async function start() {
    await stop();
    const output = fs.openSync(path.join(root, "gateway.log"), "a");
    child = spawn(process.execPath, [path.join(packageDir, "openclaw.mjs"), "gateway", "run"], {
      env: { ...process.env, OPENCLAW_DISABLE_BONJOUR: "1", OPENCLAW_NO_AUTO_UPDATE: "1" },
      detached: true,
      stdio: ["ignore", output, output],
    });
    fs.closeSync(output);
    const deadline = Date.now() + 120000;
    while (true) {
      if (child.exitCode !== null) {
        throw new Error(
          `Gateway exited: ${fs.readFileSync(path.join(root, "gateway.log"), "utf8")}`,
        );
      }
      try {
        if ((await fetch("http://127.0.0.1:18789/healthz")).ok) {
          break;
        }
      } catch {}
      assert(Date.now() < deadline, "Gateway readiness timeout");
      await delay(200);
    }
    client = await connect(["operator.admin", "operator.approvals"]);
  }
  /** An admin client is the owner; a client without operator.admin is not. */
  function connect(scopes) {
    return new Promise((resolve, reject) => {
      const connection = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        token,
        deviceIdentity: null,
        clientName: "gateway-client",
        mode: "backend",
        role: "operator",
        scopes,
        // Scope grants approval access; the cap makes this client a plugin approval route.
        caps: scopes.includes("operator.approvals") ? ["plugin-approvals"] : [],
        onHelloOk: () => resolve(connection),
        onConnectError: reject,
        onEvent: (event) => {
          if (event.event !== "plugin.approval.requested" || !activeApprovals) {
            return;
          }
          activeApprovals.push(event.payload);
          const resolution = Promise.resolve(activeBeforeApproval?.(activeRunId))
            .then(() =>
              connection.request("approval.resolve", {
                id: event.payload.id,
                kind: "plugin",
                decision: activeDecision ?? "deny",
              }),
            )
            .then(() => activeAfterApproval?.(activeRunId))
            .catch((/** @type {unknown} */ error) => {
              approvalFailure = error;
            });
          activeResolutions.push(resolution);
        },
      });
      connection.start();
    });
  }
  async function turn(
    message,
    {
      decision,
      expectError = false,
      afterApproval,
      beforeApproval,
      allowApprovalFailure = false,
      via = client,
      key = sessionKey,
    } = {},
  ) {
    activeResolutions = [];
    activeApprovals = [];
    activeDecision = decision;
    activeAfterApproval = afterApproval;
    activeBeforeApproval = beforeApproval;
    approvalFailure = undefined;
    const started = await via.request("chat.send", {
      sessionKey: key,
      message,
      idempotencyKey: randomUUID(),
    });
    assert.equal(started.status, "started");
    assert.equal(typeof started.runId, "string");
    activeRunId = started.runId;
    const wait = await via.request(
      "agent.wait",
      { runId: started.runId, timeoutMs: 300000 },
      { timeoutMs: 310000 },
    );
    // A reviewer verdict can still be in flight after the run ends.
    await Promise.all(activeResolutions);
    const history = await via.request("chat.history", { sessionKey: key, limit: 100 });
    if (approvalFailure && !allowApprovalFailure) {
      throw new Error("Approval resolution failed", { cause: approvalFailure });
    }
    const assistant = history.messages.findLast((item) => item.role === "assistant");
    const text =
      typeof assistant?.content === "string"
        ? assistant.content
        : (assistant?.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    if (!expectError && wait.status !== "ok") {
      assert.fail(`${JSON.stringify(wait)}\nGateway log tail:\n${gatewayLog().slice(-4000)}`);
    }
    const approvals = activeApprovals;
    activeApprovals = undefined;
    return { text, wait, approvals, approvalFailure };
  }
  return {
    start,
    stop,
    turn,
    connect,
    get client() {
      return client;
    },
    sessionKey,
    root,
    workspace,
    packageDir,
    config,
    saveConfig,
    gatewayLog,
  };
}
