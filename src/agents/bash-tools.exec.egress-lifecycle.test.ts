import { once } from "node:events";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:https";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { drainSystemEvents, peekSystemEventEntries } from "../infra/system-events.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { generateLocalProxyLeaf } from "../proxy-capture/ca.js";
import {
  startSecretEgressProxyServer,
  type SecretEgressProxyHandle,
} from "../secrets/egress-proxy/proxy-server.js";
import {
  clearSecretEgressProxy,
  publishSecretEgressProxy,
} from "../secrets/egress-proxy/registry.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import { deleteSession, getFinishedSession } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";
import * as sessionSlug from "./session-slug.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

const sessionKey = "agent:probe:egress-lifecycle";
let state: OpenClawTestState;
let proxy: SecretEgressProxyHandle;
let origin: Server;
let target: string;
let config: OpenClawConfig;
const admissions: PreparedAgentRunAdmission[] = [];
const processIds: string[] = [];

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function requestWithGrant(proxyUrl: string): Promise<number> {
  const url = new URL(proxyUrl);
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: target,
        agent: false,
        headers: {
          "Proxy-Authorization": `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}`,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function createInvocation(runId: string) {
  const admission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: "probe",
      ingress: { kind: "schedule", boundary: "cron.script", state: "present" },
    },
  });
  admissions.push(admission);
  const admitted = await admission.admit("gateway");
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: admitted,
    agentId: "probe",
    sessionKey,
  });
  if (!caller) {
    throw new Error("Expected an admitted caller");
  }
  const exec = createExecTool({
    config,
    agentId: "probe",
    sessionKey,
    scopeKey: sessionKey,
    runId,
    operationalRunInstance: admitted.operationalRunInstance,
    trigger: "cron",
    host: "gateway",
    security: "full",
    ask: "off",
    cwd: state.workspaceDir,
    notifyOnExit: true,
    allowBackground: true,
  });
  const control = await withGatewayToolCallerIdentity(caller, () =>
    createProcessTool({ scopeKey: sessionKey }),
  );
  return {
    admission,
    exec: (args: Parameters<typeof exec.execute>[1]) =>
      withGatewayToolCallerIdentity(caller, () => exec.execute(runId, args)),
    process: (args: Parameters<typeof control.execute>[1]) =>
      withGatewayToolCallerIdentity(caller, () => control.execute(runId, args)),
  };
}

type Invocation = Awaited<ReturnType<typeof createInvocation>>;

function hasExitEvent(sessionId: string): boolean {
  return peekSystemEventEntries(sessionKey).some(
    (event) => event.contextKey === `exec:${sessionId}`,
  );
}

async function waitForOutput(owner: Invocation, sessionId: string, text: string) {
  await vi.waitFor(
    async () => {
      const result = await owner.process({ action: "log", sessionId });
      expect(
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      ).toContain(text);
    },
    { timeout: 10_000 },
  );
}

async function startWatcher(owner: Invocation, label: string, timeoutSeconds = 30) {
  const controlPath = state.path(`${label}.command`);
  const grantPath = state.path(`${label}.grant`);
  const result = await owner.exec({
    command: `exec ${[process.execPath, state.statePath("watcher.cjs"), controlPath, grantPath, target].map(quote).join(" ")}`,
    background: true,
    timeoutSeconds,
  });
  if (result.details.status !== "running") {
    throw new Error(`Expected a background watcher: ${JSON.stringify(result.details)}`);
  }
  const sessionId = result.details.sessionId;
  processIds.push(sessionId);
  await waitForOutput(owner, sessionId, "READY");
  return {
    sessionId,
    grant: await fs.readFile(grantPath, "utf8"),
    request: async (observer: Invocation, marker: string) => {
      await fs.writeFile(controlPath, marker);
      await waitForOutput(observer, sessionId, `RESULT ${marker} 200`);
    },
    exit: () => fs.writeFile(controlPath, "exit"),
  };
}

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-exec-egress-lifecycle-",
    layout: "state-only",
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
      SHELL: "/bin/sh",
    },
  });
  proxy = await startSecretEgressProxyServer({
    caDir: state.path("proxy-ca"),
    allowedHosts: ["localhost"],
    onAudit: () => {},
  });
  publishSecretEgressProxy(proxy);
  const leaf = await generateLocalProxyLeaf({
    certDir: state.path("proxy-ca"),
    ca: { certPath: proxy.caCertPath, keyPath: state.path("proxy-ca", "root-ca-key.pem") },
    hostname: "localhost",
  });
  origin = createServer(leaf, (_request, response) => response.end("ok"));
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const address = origin.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the local HTTPS origin");
  }
  target = `https://localhost:${address.port}/watcher`;
  config = {
    agents: {
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
      entries: { probe: { workspace: state.workspaceDir } },
    },
    plugins: { enabled: false },
    tools: { exec: { host: "gateway", security: "full", ask: "off" } },
    secrets: { egressProxy: { enabled: true } },
  };
  await state.writeConfig(config);
  // A real child retains its inherited proxy environment across caller turns.
  await state.writeText(
    "watcher.cjs",
    `
const fs = require("node:fs");
const http = require("node:http");
const [controlPath, grantPath, target] = process.argv.slice(2);
fs.writeFileSync(grantPath, process.env.HTTPS_PROXY, { mode: 0o600 });
const proxy = new URL(process.env.HTTPS_PROXY);
console.log("READY");
let previous;
setInterval(() => {
  if (!fs.existsSync(controlPath)) return;
  const command = fs.readFileSync(controlPath, "utf8");
  if (command === previous) return;
  previous = command;
  if (command === "exit") process.exit(0);
  const request = http.request({
    hostname: proxy.hostname, port: proxy.port, path: target, agent: false,
    headers: { "Proxy-Authorization": "Basic " + Buffer.from(proxy.username + ":" + proxy.password).toString("base64") },
  }, (response) => {
    response.resume();
    response.on("end", () => console.log("RESULT " + command + " " + response.statusCode));
  });
  request.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  request.end();
}, 20);
`,
  );
});

afterEach(async () => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  const supervisor = getProcessSupervisor();
  const join = supervisor.acquireScopeCleanup(sessionKey, { processTree: "required-all" });
  supervisor.cancelScope(sessionKey);
  await join();
  for (const sessionId of processIds.splice(0)) {
    deleteSession(sessionId);
  }
  drainSystemEvents(sessionKey);
  if (proxy) {
    clearSecretEgressProxy(proxy);
    await proxy.stop();
  }
  if (origin) {
    origin.closeAllConnections();
    await new Promise<void>((resolve) => {
      origin.close(() => resolve());
    });
  }
  await state?.cleanup();
});

describe.skipIf(process.platform === "win32")("background exec egress lifetime", () => {
  it("survives turn closure and revokes same-turn commands independently on kill and exit", async () => {
    const slugs = vi
      .spyOn(sessionSlug, "createSessionSlug")
      .mockReturnValueOnce("oceanic-atlas")
      .mockReturnValueOnce("oceanic-basil");
    onTestFinished(() => slugs.mockRestore());
    const first = await createInvocation("egress-first");
    const killed = await startWatcher(first, "killed");
    const survivor = await startWatcher(first, "survivor");
    expect(survivor.sessionId).not.toBe(killed.sessionId);
    expect(survivor.sessionId.slice(0, 8)).toBe(killed.sessionId.slice(0, 8));
    await killed.request(first, "before-close");
    first.admission.close();

    const later = await createInvocation("egress-later");
    await killed.request(later, "after-close");
    await survivor.request(later, "sibling-after-close");
    expect(killed.grant !== survivor.grant).toBe(true);

    await later.process({ action: "kill", sessionId: killed.sessionId });
    await expect(requestWithGrant(killed.grant)).resolves.toBe(407);
    await survivor.request(later, "sibling-after-kill");
    await vi.waitFor(
      () =>
        expect(getFinishedSession(killed.sessionId)).toMatchObject({
          exitReason: "manual-cancel",
          terminalStatus: "failed",
        }),
      { timeout: 10_000 },
    );
    // Observe settlement before polling can acknowledge an unwanted notification.
    expect(hasExitEvent(killed.sessionId)).toBe(false);
    const running = await later.process({ action: "poll", sessionId: survivor.sessionId });
    expect(running.details).toMatchObject({ status: "running" });
    expect(hasExitEvent(survivor.sessionId)).toBe(false);
    await survivor.exit();
    await vi.waitFor(() => expect(hasExitEvent(survivor.sessionId)).toBe(true), {
      timeout: 10_000,
    });
    const exited = await later.process({ action: "poll", sessionId: survivor.sessionId });
    expect(exited.details).toMatchObject({ status: "completed", exitCode: 0 });
    await expect(requestWithGrant(survivor.grant)).resolves.toBe(407);
  });

  it("revokes a timed-out command before publishing its terminal result", async () => {
    const owner = await createInvocation("egress-timeout");
    const watcher = await startWatcher(owner, "timeout", 3);
    await watcher.request(owner, "before-timeout");
    await vi.waitFor(() => expect(hasExitEvent(watcher.sessionId)).toBe(true), {
      timeout: 10_000,
    });
    const result = await owner.process({ action: "poll", sessionId: watcher.sessionId });
    expect(result.details).toMatchObject({ status: "failed", exitReason: "overall-timeout" });
    await expect(requestWithGrant(watcher.grant)).resolves.toBe(407);
  });
});
