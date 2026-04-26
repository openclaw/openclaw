import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { dispatchTask } from "../src/dispatch.js";
import { readInboxMessages } from "../src/inbox.js";
import { DEFAULT_ROUTING_CONFIG } from "../src/routing.config-default.js";
import type { CompiledRoutingConfig } from "../src/routing.js";
import { createStore } from "../src/store.js";

let tmpHome: string;
let agentsDir: string;
const storeOpts = () => ({ openclawHome: tmpHome });

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "orchestrator-dispatch-"));
  agentsDir = join(tmpHome, "agents");
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function compile(): CompiledRoutingConfig {
  return {
    schemaVersion: 1,
    rules: DEFAULT_ROUTING_CONFIG.rules.map((rule) => ({
      ...rule,
      regex: new RegExp(rule.pattern, "i"),
    })),
    default: DEFAULT_ROUTING_CONFIG.default,
    approvalRequired: DEFAULT_ROUTING_CONFIG.approvalRequired,
    approvalRequiredCapabilities: DEFAULT_ROUTING_CONFIG.approvalRequiredCapabilities,
  };
}

describe("dispatchTask — synthetic mode", () => {
  test("routes + completes synthetically without enqueueing inbox", () => {
    const store = createStore(storeOpts());
    const queued = store.submit({
      goal: "please debug this function",
      submittedBy: "tester",
    });

    const result = dispatchTask(queued, store, {
      config: compile(),
      mode: "synthetic",
      agentsDir,
    });

    expect(result.enqueued).toBe(false);
    expect(result.task.assignedAgentId).toBe("coder");
    expect(result.task.routing?.matchedRuleId).toBe("code-tasks");
    expect(readInboxMessages({ agentsDir })).toEqual([]);
  });

  test("approval-required agent (coder) lands at awaiting_approval", () => {
    const store = createStore(storeOpts());
    const queued = store.submit({
      goal: "fix this bug",
      submittedBy: "tester",
    });
    const result = dispatchTask(queued, store, {
      config: compile(),
      mode: "synthetic",
      agentsDir,
    });
    expect(result.requiresApproval).toBe(true);
    expect(result.state).toBe("awaiting_approval");
  });

  test("non-approval agent (researcher) goes straight to done", () => {
    const store = createStore(storeOpts());
    const queued = store.submit({
      goal: "research the literature",
      submittedBy: "tester",
    });
    const result = dispatchTask(queued, store, {
      config: compile(),
      mode: "synthetic",
      agentsDir,
    });
    expect(result.requiresApproval).toBe(false);
    expect(result.state).toBe("done");
    expect(result.task.completedAt).not.toBeNull();
  });

  test("synthetic result text is deterministic and references the task id", () => {
    const store = createStore(storeOpts());
    const queued = store.submit({
      goal: "research X",
      submittedBy: "tester",
    });
    const result = dispatchTask(queued, store, {
      config: compile(),
      mode: "synthetic",
      agentsDir,
    });
    expect(result.task.result?.text).toContain(queued.id);
  });

  test("synthetic capability inference flags publish/ops as approval-required", () => {
    const store = createStore(storeOpts());
    const queued = store.submit({
      goal: "build the next release",
      submittedBy: "tester",
    });
    const result = dispatchTask(queued, store, {
      config: compile(),
      mode: "synthetic",
      agentsDir,
      // The default goal "build the next release" matches code-tasks → coder
      // (which is in approvalRequired). Inject a capability resolver to
      // verify the capability path also gates approval.
      inferCapabilities: () => ["publish"],
    });
    expect(result.requiresApproval).toBe(true);
  });
});

describe("dispatchTask — shadow / live mode", () => {
  test("shadow mode routes, leaves task assigned, enqueues inbox message", () => {
    const store = createStore(storeOpts());
    const queued = store.submit({
      goal: "design the new ui",
      submittedBy: "tester",
      kind: "shadow",
    });

    const result = dispatchTask(queued, store, {
      config: compile(),
      mode: "shadow",
      agentsDir,
    });

    expect(result.enqueued).toBe(true);
    expect(result.task.state).toBe("assigned");
    const inbox = readInboxMessages({ agentsDir });
    expect(inbox.length).toBe(1);
    expect(inbox[0]!.taskId).toBe(queued.id);
    expect(inbox[0]!.assignedAgentId).toBe("design-ui-designer");
    expect(inbox[0]!.goal).toBe("design the new ui");
  });

  test("live mode behaves the same on the dispatch side (spawn-watch lives elsewhere)", () => {
    const store = createStore(storeOpts());
    const queued = store.submit({
      goal: "deploy the new version",
      submittedBy: "tester",
    });

    const result = dispatchTask(queued, store, {
      config: compile(),
      mode: "live",
      agentsDir,
    });

    expect(result.enqueued).toBe(true);
    expect(result.task.state).toBe("assigned");
    expect(readInboxMessages({ agentsDir })[0]?.assignedAgentId).toBe("helpdesk");
  });
});

describe("dispatchTask — guards", () => {
  test("refuses to dispatch a task that is not queued", () => {
    const store = createStore(storeOpts());
    const queued = store.submit({
      goal: "research X",
      submittedBy: "tester",
    });
    dispatchTask(queued, store, {
      config: compile(),
      mode: "synthetic",
      agentsDir,
    });
    const completed = store.read(queued.id);
    expect(() =>
      dispatchTask(completed, store, {
        config: compile(),
        mode: "synthetic",
        agentsDir,
      }),
    ).toThrow(/must be queued/);
  });
});
