import { describe, expect, it } from "vitest";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import {
  collectPiRunWorkerBlockers,
  decidePiRunWorkerLaunch,
  normalizePiRunWorkerMode,
} from "./pi-run-worker-policy.ts";

const BASE_PARAMS = {
  agentId: "agent-1",
  runId: "run-1",
  sessionId: "session-1",
  sessionKey: "session-1",
  model: "gpt-5.5",
  prompt: "hello",
  sessionFile: "/tmp/openclaw-session.jsonl",
  timeoutMs: 1_000,
  workspaceDir: "/tmp/openclaw-workspace",
} satisfies RunEmbeddedPiAgentParams;

describe("normalizePiRunWorkerMode", () => {
  it("accepts known modes and defaults unset values to auto", () => {
    expect(normalizePiRunWorkerMode("worker")).toBe("worker");
    expect(normalizePiRunWorkerMode("true")).toBe("worker");
    expect(normalizePiRunWorkerMode("inline")).toBe("inline");
    expect(normalizePiRunWorkerMode("auto")).toBe("auto");
    expect(normalizePiRunWorkerMode(undefined)).toBe("auto");
  });

  it("keeps unknown mode values inline as a typo-safe fallback", () => {
    expect(normalizePiRunWorkerMode("bogus")).toBe("inline");
  });
});

describe("collectPiRunWorkerBlockers", () => {
  it("accepts parent-owned callback fields", () => {
    expect(
      collectPiRunWorkerBlockers({
        ...BASE_PARAMS,
        onPartialReply: () => {},
        onToolResult: () => {},
        shouldEmitToolOutput: () => true,
        hasRepliedRef: { value: false },
      }),
    ).toEqual([]);
  });

  it("allows parent queue and reply operation fields", () => {
    expect(
      collectPiRunWorkerBlockers({
        ...BASE_PARAMS,
        enqueue: () => {},
        replyOperation: { append: () => {} },
      } as unknown as RunEmbeddedPiAgentParams).map((blocker) => blocker.code),
    ).toEqual([]);
  });

  it("blocks non-parent function fields", () => {
    expect(
      collectPiRunWorkerBlockers({
        ...BASE_PARAMS,
        customHook: () => {},
      } as unknown as RunEmbeddedPiAgentParams),
    ).toContainEqual({
      code: "unbridgeable_function",
      field: "customHook",
      message: "customHook is a function and has no worker callback bridge",
    });
  });

  it("blocks nested non-cloneable values in the sanitized run params", () => {
    expect(
      collectPiRunWorkerBlockers({
        ...BASE_PARAMS,
        streamParams: {
          onChunk: () => {},
        },
      } as unknown as RunEmbeddedPiAgentParams).map((blocker) => blocker.code),
    ).toContain("non_cloneable_run_params");
  });
});

describe("decidePiRunWorkerLaunch", () => {
  it("runs inline for worker children", () => {
    expect(
      decidePiRunWorkerLaunch({
        runParams: BASE_PARAMS,
        mode: "worker",
        workerChild: true,
      }),
    ).toEqual({
      mode: "inline",
      reason: "worker_child",
    });
  });

  it("runs inline when disabled", () => {
    expect(
      decidePiRunWorkerLaunch({
        runParams: BASE_PARAMS,
        mode: "inline",
      }),
    ).toEqual({
      mode: "inline",
      reason: "disabled",
    });
  });

  it("uses workers in auto mode when the run is ready", () => {
    expect(
      decidePiRunWorkerLaunch({
        runParams: BASE_PARAMS,
        mode: "auto",
        workerEntryAvailable: true,
      }),
    ).toEqual({
      mode: "worker",
      reason: "serializable",
    });
  });

  it("uses auto worker policy by default when the run is ready", () => {
    expect(
      decidePiRunWorkerLaunch({
        runParams: BASE_PARAMS,
        workerEntryAvailable: true,
      }),
    ).toEqual({
      mode: "worker",
      reason: "serializable",
    });
  });

  it("uses workers when forced and ready", () => {
    expect(
      decidePiRunWorkerLaunch({
        runParams: BASE_PARAMS,
        mode: "worker",
        workerEntryAvailable: true,
      }),
    ).toEqual({
      mode: "worker",
      reason: "requested",
    });
  });

  it("falls back to inline in auto mode when blockers remain", () => {
    const decision = decidePiRunWorkerLaunch({
      runParams: {
        ...BASE_PARAMS,
        customHook: () => {},
      } as unknown as RunEmbeddedPiAgentParams,
      mode: "auto",
      workerEntryAvailable: true,
    });
    expect(decision).toMatchObject({
      mode: "inline",
      reason: "not_ready",
    });
    expect(decision.mode === "inline" ? decision.blockers : []).toContainEqual(
      expect.objectContaining({
        code: "unbridgeable_function",
        field: "customHook",
      }),
    );
  });

  it("throws when worker mode is forced with blockers", () => {
    expect(() =>
      decidePiRunWorkerLaunch({
        runParams: {
          ...BASE_PARAMS,
          customHook: () => {},
        } as unknown as RunEmbeddedPiAgentParams,
        mode: "worker",
        workerEntryAvailable: true,
      }),
    ).toThrow(/customHook/);
  });

  it("falls back inline in auto mode when the worker entry is unavailable", () => {
    expect(
      decidePiRunWorkerLaunch({
        runParams: BASE_PARAMS,
        mode: "auto",
        workerEntryAvailable: false,
      }),
    ).toEqual({
      mode: "inline",
      reason: "not_ready",
      blockers: [
        {
          code: "worker_entry_unavailable",
          message: "worker entry is not available in this runtime build",
        },
      ],
    });
  });

  it("fails closed in forced worker mode when the worker entry is unavailable", () => {
    expect(() =>
      decidePiRunWorkerLaunch({
        runParams: BASE_PARAMS,
        mode: "worker",
        workerEntryAvailable: false,
      }),
    ).toThrow(/worker_entry_unavailable/);
  });
});
