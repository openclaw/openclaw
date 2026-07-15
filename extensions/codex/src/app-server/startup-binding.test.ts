// Codex tests cover startup binding plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBoundedCodexNativePatchFailureDiagnostic } from "./notification-correlation.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { rotateOversizedCodexAppServerStartupBinding as rotateStartupBindingImpl } from "./startup-binding.js";

function rotateOversizedCodexAppServerStartupBinding(
  params: Omit<Parameters<typeof rotateStartupBindingImpl>[0], "bindingStore" | "identity">,
) {
  return rotateStartupBindingImpl({
    ...params,
    bindingStore: testCodexAppServerBindingStore,
    identity: { kind: "session", agentId: "main", sessionId: params.sessionFile },
  });
}

describe("Codex app-server startup binding", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-startup-binding-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeExistingBinding(
    sessionFile: string,
    workspaceDir: string,
    overrides: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
  ) {
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      ...overrides,
    });
  }

  async function writeSessionRecord(sessionFile: string, record: Record<string, unknown>) {
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      path.join(path.dirname(sessionFile), "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionFile,
          ...record,
        },
      }),
    );
  }

  it("reads a correlated native patch failure from a bounded fake rollout", async () => {
    const agentDir = path.join(tempDir, "agent");
    const codexHome = path.join(tempDir, "codex-home");
    const rolloutDir = path.join(codexHome, "sessions", "2026", "07", "15");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-2026-07-15T00-00-00-thread-1.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "patch_apply_end",
          turn_id: "turn-1",
          call_id: "patch-1",
          status: "failed",
          success: false,
          stderr: "cannot write /Users/private/source.ts",
          stdout: "checked /workspace/src/source.ts",
          changes: {
            "src/source.ts": { type: "update" },
            "/Users/private/secret.ts": { type: "add" },
          },
        },
      })}\n`,
    );

    const diagnostic = await readBoundedCodexNativePatchFailureDiagnostic({
      agentDir,
      codexHome,
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "patch-1",
    });

    expect(diagnostic).toMatchObject({
      fileChangeItemId: "patch-1",
      nativePatchApplyEndObserved: true,
      nativePatchApplyEndStatus: "failed",
      nativePatchApplyEndSuccess: false,
      nativePatchApplyEndScanBounded: true,
      nativePatchApplyEndStderrPreview: "cannot write <redacted-filechange-path>",
      nativePatchApplyEndStdoutPreview: "checked /workspace/src/source.ts",
      nativePatchApplyEndChanges: [
        { path: "src/source.ts", kind: "update" },
        { path: "<redacted-filechange-path>", kind: "add" },
      ],
    });
    expect(JSON.stringify(diagnostic)).not.toContain("/Users/private");
  });

  it("stops native patch failure inspection at the configured line bound", async () => {
    const agentDir = path.join(tempDir, "agent");
    const codexHome = path.join(tempDir, "codex-home");
    const rolloutDir = path.join(codexHome, "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-1.jsonl"),
      [
        JSON.stringify({
          payload: {
            type: "patch_apply_end",
            turn_id: "turn-1",
            call_id: "patch-1",
            status: "failed",
            stderr: "bounded failure",
          },
        }),
        JSON.stringify({ payload: { type: "noise" } }),
        JSON.stringify({ payload: { type: "newer_noise" } }),
      ].join("\n"),
    );

    const diagnostic = await readBoundedCodexNativePatchFailureDiagnostic({
      agentDir,
      codexHome,
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "patch-1",
      limits: { maxLines: 1 },
    });

    expect(diagnostic).toMatchObject({
      nativePatchApplyEndObserved: false,
      nativePatchApplyEndDiagnosticFallback: "scan_line_limit",
      nativePatchApplyEndScanBounded: true,
    });
  });

  it("rejects a suffix-colliding rollout with matching turn and call ids", async () => {
    const agentDir = path.join(tempDir, "agent");
    const codexHome = path.join(tempDir, "codex-home");
    const rolloutDir = path.join(codexHome, "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-2026-07-15T00-00-00-other-thread-1.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "patch_apply_end",
          turn_id: "turn-1",
          call_id: "patch-1",
          status: "failed",
          stderr: "must not correlate",
        },
      })}\n`,
    );

    const diagnostic = await readBoundedCodexNativePatchFailureDiagnostic({
      agentDir,
      codexHome,
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "patch-1",
    });

    expect(diagnostic).toMatchObject({
      nativePatchApplyEndObserved: false,
      nativePatchApplyEndDiagnosticFallback: "rollout_unavailable",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("must not correlate");
  });

  it.each(["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@"])(
    "rejects unified-diff preview shape %s",
    async (unsafePreview) => {
      const agentDir = path.join(tempDir, "agent");
      const codexHome = path.join(tempDir, "codex-home");
      const rolloutDir = path.join(codexHome, "sessions");
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, "rollout-thread-1.jsonl"),
        `${JSON.stringify({
          payload: {
            type: "patch_apply_end",
            turn_id: "turn-1",
            call_id: "patch-1",
            status: "failed",
            stderr: unsafePreview,
            stdout: unsafePreview,
          },
        })}\n`,
      );

      const diagnostic = await readBoundedCodexNativePatchFailureDiagnostic({
        agentDir,
        codexHome,
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "patch-1",
      });

      expect(diagnostic).toMatchObject({
        nativePatchApplyEndObserved: true,
        nativePatchApplyEndDiagnosticFallback: "unsafe_stderr_redacted",
      });
      expect(diagnostic.nativePatchApplyEndStderrPreview).toBeUndefined();
      expect(diagnostic.nativePatchApplyEndStdoutPreview).toBeUndefined();
      expect(JSON.stringify(diagnostic)).not.toContain(unsafePreview);
    },
  );

  it("redacts secret-bearing ids, status, relative paths, and change kinds", async () => {
    const agentDir = path.join(tempDir, "agent");
    const codexHome = path.join(tempDir, "codex-home");
    const rolloutDir = path.join(codexHome, "sessions");
    const unsafeTurnId = "turn-TOKEN=turn-secret";
    const unsafeCallId = "patch-PASSWORD=call-secret";
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-1.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "patch_apply_end",
          turn_id: unsafeTurnId,
          call_id: unsafeCallId,
          status: "TOKEN=status-secret",
          success: false,
          changes: {
            "src/TOKEN=path-secret.ts": { type: "PASSWORD=kind-secret" },
          },
        },
      })}\n`,
    );

    const diagnostic = await readBoundedCodexNativePatchFailureDiagnostic({
      agentDir,
      codexHome,
      threadId: "thread-1",
      turnId: unsafeTurnId,
      callId: unsafeCallId,
    });

    expect(diagnostic).toMatchObject({
      fileChangeItemId: "<redacted-call-id>",
      turnId: "<redacted-turn-id>",
      nativePatchApplyEndObserved: true,
      nativePatchApplyEndStatus: "<redacted-status>",
      nativePatchApplyEndChanges: [
        { path: "<redacted-filechange-path>", kind: "<redacted-change-kind>" },
      ],
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /turn-secret|call-secret|status-secret|path-secret|kind-secret/u,
    );
  });

  it("does not use a default byte limit when maxActiveTranscriptBytes is unset", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      "x".repeat(2_000_000),
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
            },
          },
        },
      } as never,
    });

    expect(binding?.threadId).toBe("thread-existing");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-existing");
  });

  it("never rotates a provisional supervision source binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, {
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-existing",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      pendingSupervisionBranch: {
        sourceThreadId: "thread-existing",
        lastTurnId: "turn-terminal",
      },
    });
    await writeSessionRecord(sessionFile, { totalTokens: 999_999 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      "x".repeat(2_000_000),
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: "1k",
            },
          },
        },
      } as never,
    });

    expect(binding).toMatchObject({
      threadId: "thread-existing",
      pendingSupervisionBranch: {
        sourceThreadId: "thread-existing",
        lastTurnId: "turn-terminal",
      },
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
      pendingSupervisionBranch: { sourceThreadId: "thread-existing" },
    });
  });

  it("never rotates a materialized supervised native thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, {
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });
    await writeSessionRecord(sessionFile, { totalTokens: 999_999 });

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      projectedTurnTokens: 999_999,
      config: {
        agents: {
          defaults: {
            compaction: { truncateAfterCompaction: true, maxActiveTranscriptBytes: "1b" },
          },
        },
      } as never,
    });

    expect(binding).toMatchObject({
      threadId: "thread-existing",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
      connectionScope: "supervision",
    });
  });

  it("reuses the session record cache while sessions.json is unchanged", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const sessionsJson = path.join(path.dirname(sessionFile), "sessions.json");
    const readFileSpy = vi.spyOn(fs, "readFile");

    for (let i = 0; i < 2; i += 1) {
      const binding = await rotateOversizedCodexAppServerStartupBinding({
        binding: await readCodexAppServerBinding(sessionFile),
        sessionFile,
        agentDir,
        config: undefined,
      });
      expect(binding?.threadId).toBe("thread-existing");
    }

    const sessionStoreReads = readFileSpy.mock.calls.filter(
      ([file]) => typeof file === "string" && file === sessionsJson,
    );
    expect(sessionStoreReads).toHaveLength(1);
  });

  it("checks native rollout token pressure under default compaction config", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 241_198,
            },
            model_context_window: 258_400,
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("caps the default native reserve so small context windows keep prompt budget", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 100 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 100,
            },
            model_context_window: 16_000,
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding?.threadId).toBe("thread-existing");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-existing");
  });

  it("honors shorthand byte units for native rollout limits", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(path.join(rolloutDir, "rollout-thread-existing.jsonl"), "x".repeat(2_000));

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: "1k",
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("honors custom Codex home rollout files for native rollout limits", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const codexHome = path.join(tempDir, "custom-codex-home");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(codexHome, "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(path.join(rolloutDir, "rollout-thread-existing.jsonl"), "x".repeat(2_000));

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      codexHome,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: 1_000,
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("uses current rollout token usage before cumulative usage", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 300_000,
            },
            last_token_usage: {
              total_tokens: 12_000,
            },
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: "1mb",
            },
          },
        },
      } as never,
    });

    expect(binding?.threadId).toBe("thread-existing");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-existing");
  });

  it("ignores stale session token totals for native rollout rotation", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, {
      totalTokens: 300_000,
      totalTokensFresh: false,
    });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 12_000,
            },
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: "1mb",
            },
          },
        },
      } as never,
    });

    expect(binding?.threadId).toBe("thread-existing");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-existing");
  });

  it("clears native rollouts at Codex's reported model context window", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    const rolloutFile = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.writeFile(
      rolloutFile,
      [
        JSON.stringify({
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                total_tokens: 128_000,
              },
            },
          },
        }),
        JSON.stringify({
          payload: {
            type: "token_count",
            info: {
              model_context_window: 128_000,
            },
          },
        }),
      ].join("\n") + "\n",
    );
    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: "1mb",
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("keeps native rollouts above the old guard when Codex still has context window headroom", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 86_000,
            },
            model_context_window: 272_000,
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: "1mb",
            },
          },
        },
      } as never,
    });

    expect(binding?.threadId).toBe("thread-existing");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-existing");
  });

  it("includes projected turn tokens in the native rollout pressure check", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 220_000,
            },
            model_context_window: 258_400,
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
      projectedTurnTokens: 30_000,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("uses the session context window when the native rollout omits its model window", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000, contextTokens: 258_400 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 241_198,
            },
          },
        },
      })}\n`,
    );

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: undefined,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("clears byte-oversized rollouts before reading their contents", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    const rolloutFile = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.writeFile(rolloutFile, "x".repeat(2_000));
    const openSpy = vi.spyOn(fs, "open");

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: 1_000,
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    expect(openSpy.mock.calls.some(([file]) => String(file) === rolloutFile)).toBe(false);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("clears native rollouts at the configured byte limit", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await writeSessionRecord(sessionFile, { totalTokens: 12_000 });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(path.join(rolloutDir, "rollout-thread-existing.jsonl"), "x".repeat(1_000));

    const binding = await rotateOversizedCodexAppServerStartupBinding({
      binding: await readCodexAppServerBinding(sessionFile),
      sessionFile,
      agentDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: 1_000,
            },
          },
        },
      } as never,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });
});
