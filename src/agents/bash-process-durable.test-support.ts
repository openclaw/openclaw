import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { readExecRequestOwners } from "../infra/exec-request-context.js";
import { peekSystemEventEntries } from "../infra/system-events.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { shutdownProcessSupervisor } from "../process/supervisor/index.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createDurableProcessStore } from "./bash-durable-process-store.js";
import { disposeDurableProcesses, initializeDurableProcesses } from "./bash-process-durable.js";
import {
  getSession,
  getFinishedSession,
  getActiveBackgroundExecSessionCount,
  waitForExecSession,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { durableProcessUnitName } from "./bash-process-systemd.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";

assert.equal(isMainThread, true, "Durable exec requires the host SQLite writer broker");
after(shutdownProcessSupervisor);
const sessionKey = "agent:main:durable-proof";
const sessionId = "durable-session";

// Independent external-manager fixture: production invokes these actual executables.
// The fixture records synthetic unit facts, never host credentials or command env values.
const managerSource = `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.OPENCLAW_DURABLE_MANAGER_FIXTURE;
const args = process.argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = value => fs.writeFileSync(file, JSON.stringify(value));
if (args.includes('--version')) console.log('systemd 250');
else if (args.includes('--property=Version')) console.log('Version=250');
else if (args.includes('show-environment')) console.log('UNRELATED_TOKEN=synthetic-manager-secret');
else if (args.some(arg => arg.startsWith('--unit='))) {
  const properties = Object.fromEntries(args.filter(arg => arg.startsWith('--property=')).map(arg => {
    const pair = arg.slice(11); const i = pair.indexOf('='); return [pair.slice(0,i), pair.slice(i+1)];
  }));
  const unit = args.find(arg => arg.startsWith('--unit=')).slice(7);
  const value = { unit, properties, envNames: args.filter(arg => arg.startsWith('--setenv=')),
    state: 'running', credentialInjected: process.env.GH_TOKEN === 'synthetic-env-secret' };
  save(value);
  fs.appendFileSync(properties.StandardOutput.slice(7), 'worker ready\\n');
} else if (args.includes('stop') || args.includes('reset-failed')) save(null);
else if (args.includes('show')) {
  const value = read();
  if (value && value.finalOutput) {
    fs.appendFileSync(value.properties.StandardOutput.slice(7), value.finalOutput);
    delete value.finalOutput;
    save(value);
  }
  if (!value) { console.log('LoadState=not-found'); process.exitCode = 4; }
  else console.log('LoadState=loaded\\nActiveState=active\\nSubState=' +
    (value.state === 'running' ? 'running' : 'exited') + '\\nMainPID=' +
    (value.state === 'running' ? '4321' : '0') + '\\nExecMainCode=1\\nExecMainStatus=' +
    (value.exitCode || 0) + '\\nResult=' + (value.exitCode ? 'exit-code' : 'success'));
} else process.exitCode = 1;
`;

type ManagerRecord = {
  unit: string;
  state: string;
  properties: Record<string, string>;
  credentialInjected: boolean;
  exitCode?: number;
};

async function scenario(run: (state: OpenClawTestState, managerFile: string) => Promise<void>) {
  await withOpenClawTestState({ label: "durable-registry" }, async (state) => {
    const bin = state.path("systemd-bin");
    const managerFile = state.path("systemd-manager-fixture.json");
    await fs.mkdir(bin);
    await fs.writeFile(managerFile, "null");
    await fs.writeFile(path.join(bin, "systemctl"), managerSource, { mode: 0o700 });
    await fs.symlink("systemctl", path.join(bin, "systemd-run"));
    await withEnvAsync(
      {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
        SHELL: "/bin/sh",
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
        OPENCLAW_CHILD_OOM_SCORE_ADJ: "0",
        OPENCLAW_DURABLE_MANAGER_FIXTURE: managerFile,
        XDG_RUNTIME_DIR: state.path("runtime"),
        DBUS_SESSION_BUS_ADDRESS: "unix:path=synthetic-user-manager",
      },
      async () => {
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.defineProperty(process, "platform", { value: "linux" });
        try {
          setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
          openOpenClawStateDatabase({ env: state.env });
          const agent = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
          writeSessionEntry(agent, sessionKey, { sessionId, updatedAt: Date.now() });
          await run(state, managerFile);
        } finally {
          await disposeDurableProcesses();
          resetProcessRegistryForTests();
          resetGatewayWorkAdmission();
          await nextTurn();
          Object.defineProperty(process, "platform", platform);
        }
      },
    );
  });
}

async function launch(state: OpenClawTestState, notifyOnExit: boolean) {
  const tool = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    bypassHostApprovalFloors: true,
    agentId: "main",
    sessionKey,
    sessionId,
    scopeKey: sessionKey,
    cwd: state.workspaceDir,
    notifyOnExit,
    notifyOnExitEmptySuccess: true,
    preparedRunEnvironment: {
      credentialScrubEnv: {},
      localIdentityEnv: { GH_TOKEN: "synthetic-env-secret", GH_HOST: "github.com" },
      excludedStoreNames: ["GH_TOKEN", "GH_HOST"],
      managedLocalIdentity: true,
    },
    preparedStoreEnvironment: {},
    preparedSubagentExecution: false,
  });
  const result = await tool.execute("durable-launch", {
    command: "printf worker --credential synthetic-command-secret",
    background: true,
    durable: true,
    timeoutSeconds: 60,
  });
  assert.ok(result.details?.status === "running", JSON.stringify(result));
  assert.ok(result.details.sessionId);
  return result.details.sessionId;
}

void it("re-adopts persisted work with scoped list/log/poll/kill and restart admission", async () => {
  await scenario(async (state, managerFile) => {
    await initializeDurableProcesses();
    const id = await launch(state, false);
    const store = createDurableProcessStore();
    const [record] = await store.list();
    assert.equal(record?.id, id);
    assert.equal(record?.unitName, durableProcessUnitName(id));
    assert.doesNotMatch(JSON.stringify(record), /synthetic-/);
    assert.equal(getActiveBackgroundExecSessionCount(), 0);
    const manager: ManagerRecord = JSON.parse(await fs.readFile(managerFile, "utf8"));
    assert.equal(manager.credentialInjected, true);
    assert.equal(manager.properties.KillMode, "control-group");
    assert.equal(manager.properties.RuntimeMaxSec, "60s");
    assert.equal(manager.properties.UnsetEnvironment, "UNRELATED_TOKEN");
    await disposeDurableProcesses();
    resetProcessRegistryForTests();
    assert.equal(JSON.parse(await fs.readFile(managerFile, "utf8")).state, "running");
    await initializeDurableProcesses();
    const tool = createProcessTool({ agentId: "main", sessionKey, scopeKey: sessionKey });
    const list = await tool.execute("list", { action: "list" });
    assert.partialDeepStrictEqual(list.details, {
      sessions: [{ sessionId: id, status: "running" }],
    });
    const log = await tool.execute("log", { action: "log", sessionId: id });
    assert.match(JSON.stringify(log), /worker ready/);
    assert.doesNotMatch(JSON.stringify(log), /synthetic-env-secret/);
    const write = await tool.execute("write", { action: "write", sessionId: id, data: "input" });
    assert.match(JSON.stringify(write), /no interactive input/);
    const adopted = getSession(id)!;
    await tool.execute("kill", { action: "kill", sessionId: id });
    await waitForExecSession(adopted);
    const poll = await tool.execute("poll", { action: "poll", sessionId: id });
    assert.partialDeepStrictEqual(poll.details, {
      status: "completed",
      exitReason: "manual-cancel",
    });
    assert.equal(JSON.parse(await fs.readFile(managerFile, "utf8")), null);
    assert.partialDeepStrictEqual((await store.list())[0], {
      cancellationRequested: true,
      notificationSettled: true,
    });
  });
});

void it("records a downtime exit and queues one unattributed session completion", async () => {
  await scenario(async (state, managerFile) => {
    await initializeDurableProcesses();
    const id = await launch(state, true);
    await disposeDurableProcesses();
    resetProcessRegistryForTests();
    const manager: ManagerRecord = JSON.parse(await fs.readFile(managerFile, "utf8"));
    await fs.writeFile(
      managerFile,
      JSON.stringify({
        ...manager,
        state: "exited",
        exitCode: 7,
        finalOutput: "worker final output\\n",
      }),
    );
    // Hold real event admission so the fixture observes the queued wake without a model request.
    const suspended = tryBeginGatewaySuspendAdmission(() => {});
    assert.ok(suspended?.commit());
    try {
      await initializeDurableProcesses();
      const tool = createProcessTool({ agentId: "main", sessionKey, scopeKey: sessionKey });
      const adopted = getSession(id)!;
      const poll = await tool.execute("downtime", { action: "poll", sessionId: id });
      await waitForExecSession(adopted);
      assert.match(JSON.stringify(poll), /worker final output/);
      assert.equal(getFinishedSession(id)?.exitCode, 7);
      assert.partialDeepStrictEqual((await createDurableProcessStore().list())[0], {
        result: { exitCode: 7 },
        notificationSettled: true,
      });
      const events = peekSystemEventEntries(sessionKey);
      assert.equal(events.length, 1);
      assert.match(events[0]!.text, /code 7/);
      assert.match(events[0]!.text, /worker final output/);
      assert.equal(readExecRequestOwners(events[0]!), undefined);
      await disposeDurableProcesses();
      resetProcessRegistryForTests();
      await initializeDurableProcesses();
      const reAdopted = getSession(id)!;
      await tool.execute("retained", { action: "poll", sessionId: id });
      await waitForExecSession(reAdopted);
      assert.equal(peekSystemEventEntries(sessionKey).length, 1);
      // Retire the queued occurrence before reopening admission; no inference is needed for queue proof.
      const { consumeSelectedSystemEventEntries } = await import("../infra/system-events.js");
      consumeSelectedSystemEventEntries(sessionKey, events);
    } finally {
      suspended!.release("fixture complete");
    }
  });
});
