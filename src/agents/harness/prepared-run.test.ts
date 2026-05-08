import { describe, expect, it } from "vitest";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type { EmbeddedRunAttemptParams } from "../pi-embedded-runner/run/types.js";
import {
  createPreparedAgentRunFromAttempt,
  createPreparedAgentRunFromRunParams,
  createSerializableRunParamsSnapshot,
} from "./prepared-run.js";

function createAttempt(
  overrides: Partial<EmbeddedRunAttemptParams> = {},
): EmbeddedRunAttemptParams {
  return {
    runId: "run-prepared",
    sessionId: "session-prepared",
    sessionKey: "agent:ops:thread",
    sessionFile: "sqlite-transcript://ops/session-prepared.jsonl",
    workspaceDir: "/tmp/workspace",
    agentDir: "/tmp/agent",
    prompt: "hello",
    provider: "openai",
    modelId: "gpt-5.5",
    timeoutMs: 1000,
    config: { agents: { defaults: { model: "gpt-5.5" } } },
    onPartialReply: () => undefined,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    ...overrides,
  } as EmbeddedRunAttemptParams;
}

describe("createPreparedAgentRunFromAttempt", () => {
  it("reduces a live harness attempt to a serializable worker descriptor", () => {
    const prepared = createPreparedAgentRunFromAttempt(createAttempt(), {
      filesystemMode: "vfs-scratch",
      runtimeId: "pi",
    });

    expect(structuredClone(prepared)).toEqual(prepared);
    expect(prepared).toEqual({
      runtimeId: "pi",
      runId: "run-prepared",
      agentId: "ops",
      sessionId: "session-prepared",
      sessionKey: "agent:ops:thread",
      sessionFile: "sqlite-transcript://ops/session-prepared.jsonl",
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      prompt: "hello",
      provider: "openai",
      model: "gpt-5.5",
      timeoutMs: 1000,
      filesystemMode: "vfs-scratch",
      deliveryPolicy: { emitToolResult: true, emitToolOutput: false },
      config: { agents: { defaults: { model: "gpt-5.5" } } },
    });
    expect("onPartialReply" in prepared).toBe(false);
    expect("shouldEmitToolResult" in prepared).toBe(false);
  });

  it("defaults to the main agent and disk filesystem mode", () => {
    const prepared = createPreparedAgentRunFromAttempt(
      createAttempt({
        agentId: undefined,
        sessionKey: undefined,
      }),
    );

    expect(prepared.agentId).toBe("main");
    expect(prepared.filesystemMode).toBe("disk");
  });

  it("rejects non-serializable config before worker handoff", () => {
    expect(() =>
      createPreparedAgentRunFromAttempt(
        createAttempt({
          config: { bad: () => undefined } as unknown as EmbeddedRunAttemptParams["config"],
        }),
      ),
    ).toThrow("structured-clone serializable");
  });
});

describe("createPreparedAgentRunFromRunParams", () => {
  it("reduces the higher-level run params before live model and auth setup", () => {
    const prepared = createPreparedAgentRunFromRunParams(
      {
        runId: "run-high-level",
        sessionId: "session-high-level",
        sessionKey: "agent:ops:thread",
        sessionFile: "sqlite-transcript://ops/session-high-level.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "openai",
        model: "gpt-5.5",
        timeoutMs: 1000,
        initialVfsEntries: [
          {
            path: ".openclaw/attachments/seed/file.txt",
            contentBase64: Buffer.from("seed").toString("base64"),
            metadata: { source: "test" },
          },
        ],
        messageChannel: "slack",
        messageTo: "C123",
        currentThreadTs: "171234.000",
        images: [{ type: "image", data: "base64-image", mimeType: "image/png" }],
        toolsAllow: ["read", "exec"],
        hasRepliedRef: { value: false },
        onPartialReply: () => undefined,
        enqueue: (() => undefined) as never,
        replyOperation: { attachBackend: () => undefined } as never,
        agentFilesystem: { scratch: {} as never, artifacts: {} as never },
        shouldEmitToolResult: () => false,
        shouldEmitToolOutput: () => true,
      } as RunEmbeddedPiAgentParams,
      { runtimeId: "pi" },
    );

    expect(structuredClone(prepared)).toEqual(prepared);
    expect(prepared).toMatchObject({
      runtimeId: "pi",
      runId: "run-high-level",
      agentId: "ops",
      provider: "openai",
      model: "gpt-5.5",
      initialVfsEntries: [
        {
          path: ".openclaw/attachments/seed/file.txt",
          contentBase64: Buffer.from("seed").toString("base64"),
          metadata: { source: "test" },
        },
      ],
      deliveryPolicy: { emitToolResult: false, emitToolOutput: true },
      runParams: {
        runId: "run-high-level",
        sessionId: "session-high-level",
        sessionKey: "agent:ops:thread",
        sessionFile: "sqlite-transcript://ops/session-high-level.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "openai",
        model: "gpt-5.5",
        timeoutMs: 1000,
        initialVfsEntries: [
          {
            path: ".openclaw/attachments/seed/file.txt",
            contentBase64: Buffer.from("seed").toString("base64"),
            metadata: { source: "test" },
          },
        ],
        messageChannel: "slack",
        messageTo: "C123",
        currentThreadTs: "171234.000",
        images: [{ type: "image", data: "base64-image", mimeType: "image/png" }],
        toolsAllow: ["read", "exec"],
      },
    });
    expect("onPartialReply" in prepared.runParams!).toBe(false);
    expect("hasRepliedRef" in prepared.runParams!).toBe(false);
    expect("enqueue" in prepared.runParams!).toBe(false);
    expect("replyOperation" in prepared.runParams!).toBe(false);
    expect("agentFilesystem" in prepared.runParams!).toBe(false);
    expect(prepared.deliveryPolicy).toMatchObject({
      bridgeReplyOperation: true,
      trackHasReplied: true,
    });
  });

  it("rejects nested non-serializable high-level run fields", () => {
    expect(() =>
      createPreparedAgentRunFromRunParams({
        runId: "run-high-level",
        sessionId: "session-high-level",
        sessionFile: "sqlite-transcript://main/session-high-level.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        timeoutMs: 1000,
        streamParams: { bad: () => undefined } as never,
      } as RunEmbeddedPiAgentParams),
    ).toThrow("structured-clone serializable");
  });
});

describe("createSerializableRunParamsSnapshot", () => {
  it("keeps serializable policy fields and strips parent-only handles", () => {
    const snapshot = createSerializableRunParamsSnapshot({
      runId: "run-snapshot",
      sessionId: "session-snapshot",
      sessionFile: "sqlite-transcript://main/session-snapshot.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 1000,
      inputProvenance: { kind: "external_user", sourceChannel: "slack" },
      internalEvents: [{ type: "agent.did-something", data: { ok: true } } as never],
      onAgentEvent: () => undefined,
      abortSignal: new AbortController().signal,
      shouldEmitToolResult: () => true,
    } as RunEmbeddedPiAgentParams);

    expect(snapshot).toMatchObject({
      runId: "run-snapshot",
      sessionId: "session-snapshot",
      inputProvenance: { kind: "external_user", sourceChannel: "slack" },
      internalEvents: [{ type: "agent.did-something", data: { ok: true } }],
    });
    expect("onAgentEvent" in snapshot).toBe(false);
    expect("abortSignal" in snapshot).toBe(false);
    expect("shouldEmitToolResult" in snapshot).toBe(false);
  });
});
