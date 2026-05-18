import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_DERIVED_STALE,
  checkCanonicalOrchestratorStateAtStartup,
  queryCanonicalOrchestratorState,
} from "./orchestrator-state-query.js";

const NOW_MS = Date.parse("2026-05-17T22:00:00.000Z");

function makeStateDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wave8-state-query-"));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(path.join(stateDir, "issues"), { recursive: true });
  return stateDir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

describe("canonical orchestrator state query", () => {
  it("normalizes object-shaped issue statuses", () => {
    const stateDir = makeStateDir();
    writeJson(path.join(stateDir, "orchestrator.json"), {
      phase: "ready",
      activeTaskContractId: "contract-1",
      authorizedRootIssue: "root-1",
      authorizationSourceHash: "auth-hash",
    });
    writeJson(path.join(stateDir, "issues", "root-1.json"), {
      id: "root-1",
      rootIssue: "root-1",
      status: { state: { label: "Human Review" } },
      activeTaskContractId: "contract-1",
      authorizedRootIssue: "root-1",
      authorizationSourceHash: "auth-hash",
    });

    const query = queryCanonicalOrchestratorState({ stateDir, rootIssue: "root-1", nowMs: NOW_MS });

    expect(query.selectedIssue?.status).toMatchObject({
      label: "Human Review",
      key: "human-review",
    });
    expect(query.renderState.counts.review).toBe(1);
    expect(query.renderState.issueIds.review).toEqual(["root-1"]);
  });

  it("marks render-state-style STATE.md stale during startup checks", () => {
    const stateDir = makeStateDir();
    writeJson(path.join(stateDir, "orchestrator.json"), {
      phase: "blocked",
      activeTaskContractId: "contract-1",
      authorizedRootIssue: "root-1",
      authorizationSourceHash: "auth-hash",
    });
    writeJson(path.join(stateDir, "issues", "root-1.json"), {
      id: "root-1",
      rootIssue: "root-1",
      state: "Blocked",
      activeTaskContractId: "contract-1",
      authorizedRootIssue: "root-1",
      authorizationSourceHash: "auth-hash",
    });
    fs.writeFileSync(
      path.join(path.dirname(stateDir), "STATE.md"),
      "# STATE\n\n## Phase\nready\n\n## Status\nNo active issues.\n",
    );

    const startup = checkCanonicalOrchestratorStateAtStartup({
      stateDir,
      rootIssue: "root-1",
      nowMs: NOW_MS,
    });

    expect(startup.ok).toBe(false);
    expect(startup.reasonCode).toBe(STATE_DERIVED_STALE);
    expect(startup.query.derivedStateStale).toBe(true);
    expect(startup.query.derivedState?.status?.key).toBe("ready");
    expect(startup.query.renderState.phase.key).toBe("blocked");
  });

  it("computes render-state-compatible issue counts and status text", () => {
    const stateDir = makeStateDir();
    writeJson(path.join(stateDir, "orchestrator.json"), { phase: "blocked" });
    for (const issue of [
      { id: "a", state: "In Progress" },
      { id: "b", state: "Blocked" },
      { id: "c", state: "Human Review" },
      { id: "d", status: { state: "Blocked" } },
      { id: "e", state: "Done" },
    ]) {
      writeJson(path.join(stateDir, "issues", `${issue.id}.json`), issue);
    }

    const query = queryCanonicalOrchestratorState({ stateDir, rootIssue: "b", nowMs: NOW_MS });

    expect(query.renderState.counts).toEqual({ running: 1, blocked: 2, review: 1 });
    expect(query.renderState.issueIds).toEqual({
      running: ["a"],
      blocked: ["b", "d"],
      review: ["c"],
    });
    expect(query.renderState.statusText).toBe("Blocked on 2 issue(s).");
  });

  it("marks STATE.md stale when derived status text disagrees with render-state output", () => {
    const stateDir = makeStateDir();
    writeJson(path.join(stateDir, "orchestrator.json"), { phase: "blocked" });
    writeJson(path.join(stateDir, "issues", "root-1.json"), { id: "root-1", state: "Blocked" });
    fs.writeFileSync(
      path.join(path.dirname(stateDir), "STATE.md"),
      "# STATE\n\n## Phase\nblocked\n\n## Status\nNo active issues.\n",
    );

    const query = queryCanonicalOrchestratorState({ stateDir, rootIssue: "root-1", nowMs: NOW_MS });

    expect(query.derivedStateStale).toBe(true);
    expect(query.derivedState?.reasonCode).toBe(STATE_DERIVED_STALE);
    expect(query.derivedState?.status?.key).toBe("blocked");
    expect(query.derivedState?.statusText).toBe("No active issues.");
    expect(query.renderState.statusText).toBe("Blocked on 1 issue(s).");
  });

  it("reports finalizer and path-validation diagnostics without clobbering state", () => {
    const stateDir = makeStateDir();
    writeJson(path.join(stateDir, "orchestrator.json"), { phase: "blocked" });
    writeJson(path.join(stateDir, "issues", "root-1.json"), {
      id: "root-1",
      state: "Blocked",
      status: {
        finalizer: { required: true, error: "missing final report" },
        pathValidation: { ok: false, error: "unexpected output path" },
      },
    });

    const query = queryCanonicalOrchestratorState({ stateDir, rootIssue: "root-1", nowMs: NOW_MS });

    expect(query.selectedIssue?.status).toMatchObject({ label: "Blocked", key: "blocked" });
    expect(query.selectedIssue?.diagnostics?.join("\n")).toContain("status.finalizer");
    expect(query.selectedIssue?.diagnostics?.join("\n")).toContain("status.pathValidation");
    expect(query.renderState.counts.blocked).toBe(1);
  });
});
