import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function createPolicyFileName(): string {
  return path.join(
    os.tmpdir(),
    `openclaw-memory-governance-policy-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

type HookMap = Record<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>;

function createApi(params?: { pluginConfig?: Record<string, unknown> }) {
  const hooks: HookMap = {};
  const api = {
    id: "frankos-memory-governance",
    name: "FrankOS Memory Governance",
    pluginConfig: params?.pluginConfig ?? {},
    config: {},
    runtime: {
      events: {
        emitDiagnosticEvent: vi.fn(),
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    on: vi.fn((hookName: string, handler: HookMap[string]) => {
      hooks[hookName] = handler;
    }),
  };
  return { api, hooks };
}

function buildPolicy() {
  return {
    version: "1.0.0",
    defaultDecision: "permit",
    rules: [
      {
        id: "require-provenance",
        priority: 100,
        decision: "prohibit",
        reasonCode: "MEMORY_MISSING_PROVENANCE",
        reasonText: "Missing provenance metadata",
        match: { toolName: "memory_store" },
        constraints: {
          requiredPaths: [
            "metadata.provenance.sourceId",
            "metadata.provenance.sourcePath",
            "metadata.provenance.observedAt",
          ],
        },
      },
      {
        id: "require-classification",
        priority: 90,
        decision: "prohibit",
        reasonCode: "MEMORY_MISSING_CLASSIFICATION",
        reasonText: "Missing observed/inferred classification",
        match: { toolName: "memory_store" },
        constraints: {
          enumPaths: [
            {
              path: "metadata.classification",
              allowed: ["observed", "inferred"],
            },
          ],
        },
      },
      {
        id: "inferred-requires-basis",
        priority: 80,
        decision: "escalate",
        reasonCode: "MEMORY_INFERENCE_BASIS_REQUIRED",
        reasonText: "Inference requires basis and confidence",
        match: { toolName: "memory_store" },
        constraints: {
          when: [{ path: "metadata.classification", equals: "inferred" }],
          requiredPaths: ["metadata.inferenceBasis"],
          numberRanges: [{ path: "metadata.confidence", min: 0.6, max: 1 }],
        },
      },
      {
        id: "correction-requires-supersedes",
        priority: 70,
        decision: "escalate",
        reasonCode: "MEMORY_SUPERSESSION_LINK_REQUIRED",
        reasonText: "Correction must link superseded memory ids",
        match: { toolName: "memory_store" },
        constraints: {
          when: [{ path: "metadata.correction", equals: true }],
          arrayMinLengths: [{ path: "metadata.supersedes", minLength: 1 }],
        },
      },
    ],
  };
}

describe("frankos-memory-governance plugin", () => {
  const cleanupFiles: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(cleanupFiles.map((file) => fs.rm(file, { force: true })));
    cleanupFiles.length = 0;
  });

  it("registers before_tool_call hook", () => {
    const { api } = createApi();
    plugin.register(api as never);
    expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
  });

  it("shadow mode allows missing provenance but emits decision + validation failure", async () => {
    const policyFile = createPolicyFileName();
    cleanupFiles.push(policyFile);
    await fs.writeFile(policyFile, JSON.stringify(buildPolicy()));

    const { api, hooks } = createApi({
      pluginConfig: {
        mode: "shadow",
        policyFile,
      },
    });
    plugin.register(api as never);

    const result = await hooks.before_tool_call?.(
      {
        toolName: "memory_store",
        params: {
          text: "Remember this",
          metadata: {
            classification: "observed",
            confidence: 0.9,
          },
        },
        runId: "run-shadow-provenance",
      },
      { sessionId: "session-shadow", sessionKey: "main:shadow" },
    );

    expect(result).toBeUndefined();
    expect(api.runtime.events.emitDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.governance.decision",
        decision: "prohibit",
        reasonCode: "MEMORY_MISSING_PROVENANCE",
        mode: "shadow",
      }),
    );
    expect(api.runtime.events.emitDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.provenance.validation_failure",
        reasonCode: "MEMORY_MISSING_PROVENANCE",
      }),
    );
  });

  it("enforce mode blocks when inferred memory is missing inferenceBasis", async () => {
    const policyFile = createPolicyFileName();
    cleanupFiles.push(policyFile);
    await fs.writeFile(policyFile, JSON.stringify(buildPolicy()));

    const { api, hooks } = createApi({
      pluginConfig: {
        mode: "enforce",
        policyFile,
      },
    });
    plugin.register(api as never);

    const result = await hooks.before_tool_call?.(
      {
        toolName: "memory_store",
        params: {
          text: "Frank probably prefers shorter updates",
          metadata: {
            classification: "inferred",
            confidence: 0.8,
            provenance: {
              sourceId: "msg-1",
              sourcePath: "sessions/abc.jsonl",
              observedAt: "2026-03-08T10:00:00Z",
            },
          },
        },
      },
      { sessionId: "session-enforce", sessionKey: "main:enforce" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        block: true,
        blockReason: expect.stringContaining("MEMORY_GOVERNANCE_ESCALATE_REQUIRED"),
      }),
    );
  });

  it("shadow mode allows inferred memory missing inferenceBasis and emits escalate decision", async () => {
    const policyFile = createPolicyFileName();
    cleanupFiles.push(policyFile);
    await fs.writeFile(policyFile, JSON.stringify(buildPolicy()));

    const { api, hooks } = createApi({
      pluginConfig: {
        mode: "shadow",
        policyFile,
      },
    });
    plugin.register(api as never);

    const result = await hooks.before_tool_call?.(
      {
        toolName: "memory_store",
        params: {
          text: "Inferred preference",
          metadata: {
            classification: "inferred",
            confidence: 0.75,
            provenance: {
              sourceId: "msg-inferred-shadow",
              sourcePath: "sessions/inferred-shadow.jsonl",
              observedAt: "2026-03-08T11:10:00Z",
            },
          },
        },
      },
      { sessionId: "session-shadow-inferred", sessionKey: "main:shadow-inferred" },
    );

    expect(result).toBeUndefined();
    expect(api.runtime.events.emitDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.governance.decision",
        decision: "escalate",
        reasonCode: "MEMORY_INFERENCE_BASIS_REQUIRED",
        mode: "shadow",
      }),
    );
  });

  it("enforce mode blocks when classification is missing", async () => {
    const policyFile = createPolicyFileName();
    cleanupFiles.push(policyFile);
    await fs.writeFile(policyFile, JSON.stringify(buildPolicy()));

    const { api, hooks } = createApi({
      pluginConfig: {
        mode: "enforce",
        policyFile,
      },
    });
    plugin.register(api as never);

    const result = await hooks.before_tool_call?.(
      {
        toolName: "memory_store",
        params: {
          text: "Fact without explicit observed/inferred classification",
          metadata: {
            confidence: 0.9,
            provenance: {
              sourceId: "msg-no-class",
              sourcePath: "sessions/no-class.jsonl",
              observedAt: "2026-03-08T11:20:00Z",
            },
          },
        },
      },
      { sessionId: "session-no-class", sessionKey: "main:no-class" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        block: true,
        blockReason: expect.stringContaining("MEMORY_GOVERNANCE_PROHIBITED"),
      }),
    );
  });

  it("emits correction supersession event when correction links superseded ids", async () => {
    const policyFile = createPolicyFileName();
    cleanupFiles.push(policyFile);
    await fs.writeFile(policyFile, JSON.stringify(buildPolicy()));

    const { api, hooks } = createApi({
      pluginConfig: {
        mode: "enforce",
        policyFile,
      },
    });
    plugin.register(api as never);

    const result = await hooks.before_tool_call?.(
      {
        toolName: "memory_store",
        params: {
          text: "Corrected preference: summaries should be concise",
          metadata: {
            classification: "observed",
            confidence: 0.95,
            correction: true,
            supersedes: ["mem-old-1"],
            provenance: {
              sourceId: "msg-2",
              sourcePath: "sessions/xyz.jsonl",
              observedAt: "2026-03-08T11:00:00Z",
            },
          },
        },
      },
      { sessionId: "session-correction", sessionKey: "main:correction" },
    );

    expect(result).toBeUndefined();
    expect(api.runtime.events.emitDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.correction.supersession",
        action: "linked",
        supersedes: ["mem-old-1"],
      }),
    );
  });

  it("enforce mode fails closed when policy file is missing", async () => {
    const { api, hooks } = createApi({
      pluginConfig: {
        mode: "enforce",
        policyFile: path.join(os.tmpdir(), "missing-memory-policy.json"),
      },
    });
    plugin.register(api as never);

    const result = await hooks.before_tool_call?.(
      {
        toolName: "memory_store",
        params: {
          text: "Remember this",
          metadata: {},
        },
      },
      { sessionId: "session-missing", sessionKey: "main:missing" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        block: true,
        blockReason: expect.stringContaining("MEMORY_POLICY_EVAL_FAILED"),
      }),
    );
  });
});
