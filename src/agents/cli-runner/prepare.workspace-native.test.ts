import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "../../../extensions/anthropic/api.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { resolveBootstrapContextForRun } from "../bootstrap-files.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import { getCliSessionBinding, setCliSessionBinding } from "../cli-session.js";
import { buildBootstrapContextForFiles } from "../embedded-agent-helpers/bootstrap.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  buildProjectContextSection,
  prepareContextFilesForPrompt,
} from "../system-prompt-context-files.js";
import { resolveCliSessionId } from "./cli-run-recovery.js";
import { executePreparedCliRun } from "./execute.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

// The subprocess records the actual bytes written by the managed transport, without a provider.
const PROTOCOL = String.raw`
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let hooks;
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    hooks = message.request.hooks;
    send({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{commands:[],models:[]}}});
  } else if (message.type === "user") {
    const compact = message.message.content.includes("COMPACT_FIXTURE");
    send({type:"control_request",request_id:"workspace",request:{subtype:"hook_callback",callback_id:compact?hooks.SessionStart[0].hookCallbackIds[0]:hooks.UserPromptSubmit[0].hookCallbackIds[0],input:compact?{hook_event_name:"SessionStart",source:"compact"}:{hook_event_name:"UserPromptSubmit",prompt:message.message.content}}});
  } else if (message.type === "control_response") {
    appendFileSync("native-hook.receipts",JSON.stringify({...message,argv:process.argv.slice(2)})+"\n");
    send({type:"result",subtype:"success",session_id:"synthetic-native",result:JSON.stringify(message.response)});
  }
}
`;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  cliBackendsTesting.resetDepsForTest();
  resetCliRunnerPrepareTestDeps();
  clearRuntimeConfigSnapshot();
});

it("rejects workspace snapshots at unsupported CLI admission", async () => {
  const fixture = createCliRunnerPrepareFixture((params) => {
    setRuntimeConfigSnapshot(params.config ?? {});
    return prepareCliRunContext(params);
  });
  cleanup = () => fixture.cleanup();
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
    loadManifestModelCatalog: () => [],
  });
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
  });
  await expect(
    fixture.prepare({
      config: { agents: { defaults: { workspaceContextRefresh: "compaction" } } },
    }),
  ).rejects.toThrow(
    "workspaceContextRefresh=compaction requires the managed local Claude CLI harness",
  );
});

it("bounds legacy raw snapshots at restarted native output, isolates reassignment, and rejects revoked refresh", async () => {
  const fixture = createCliRunnerPrepareFixture((params) => {
    setRuntimeConfigSnapshot(params.config ?? {});
    return prepareCliRunContext(params);
  });
  const cleanups: Array<() => Promise<void> | void> = [];
  cleanup = async () => {
    for (const fn of cleanups.toReversed()) {
      await fn();
    }
    await fixture.cleanup();
  };
  const { dir, sessionTarget: target } = fixture.session;
  const script = path.join(dir, "native-protocol.mjs");
  await fs.writeFile(script, PROTOCOL);
  const nativeBackend = buildAnthropicCliBackend();
  const backend = {
    ...buildDefaultTestCliBackend(),
    id: "claude-cli",
    config: {
      ...buildDefaultTestCliBackend().config,
      command: process.execPath,
      input: "stdin" as const,
      output: "jsonl" as const,
      resumeArgs: ["--resume", "{sessionId}", "--print"],
    },
    prepareExecution: async (
      context: Parameters<NonNullable<typeof nativeBackend.prepareExecution>>[0],
    ) => {
      const prepared = await nativeBackend.prepareExecution?.(context);
      const execute = prepared?.execute;
      if (!execute) {
        throw new Error("Anthropic backend did not prepare its managed transport");
      }
      return {
        ...prepared,
        execute: (executionContext: Parameters<typeof execute>[0]) =>
          execute({
            ...executionContext,
            args: [script, ...executionContext.args],
            timeoutMs: 10_000,
          }),
      };
    },
  };
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [backend],
  });
  let refreshEntered: (() => void) | undefined;
  let refreshRelease = Promise.resolve();
  const loadBootstrap = resolveBootstrapContextForRun;
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    resolveBootstrapContextForRun: async (params) => {
      refreshEntered?.();
      await refreshRelease;
      return loadBootstrap(params);
    },
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
    loadManifestModelCatalog: () => [],
    claudeCliSessionTranscriptHasContent: async () => true,
    claudeCliSessionTranscriptHasOrphanedToolUse: async () => false,
  });
  const agentDir = path.join(dir, "agents", "main", "agent");
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "anthropic",
          access: "synthetic-native-access",
          refresh: "synthetic-native-refresh",
          expires: Date.now() + 60_000,
        },
      },
    },
    agentDir,
  );
  const alice = ensureProfileForEmail("alice@example.test");
  const bob = ensureProfileForEmail("bob@example.test");
  for (const [profile, text] of [
    [alice.id, "ALICE_PRIVATE"],
    [bob.id, "BOB_PRIVATE"],
  ]) {
    await fs.mkdir(path.join(dir, "users", profile), { recursive: true });
    await fs.writeFile(path.join(dir, "users", profile, "USER.md"), text);
  }
  const raw = "FROZEN_WORKSPACE_" + "x".repeat(10_000 - "FROZEN_WORKSPACE_".length);
  await fs.writeFile(path.join(dir, "AGENTS.md"), raw);
  await fs.writeFile(path.join(dir, "SOUL.md"), "SOUL_" + "s".repeat(2000));
  let sequence = 0;
  const prepare = async (
    profile: string,
    max = 20_000,
    total = 30_000,
    binding?: ReturnType<typeof getCliSessionBinding>,
  ) => {
    const runId = `native-snapshot-${++sequence}`;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          workspaceContextRefresh: "compaction",
          bootstrapMaxChars: max,
          bootstrapTotalMaxChars: total,
        },
      },
    };
    const admission = prepareSystemAgentRunAdmission(
      config,
      runId,
      "main",
      "native-snapshot-proof",
    );
    cleanups.push(() => admission.close());
    await patchSessionEntryCore(target, (entry) => ({ ...entry, activeWriterRunId: runId }));
    const run = <T>(fn: () => Promise<T>) =>
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: { ...target, expectedWriterRunId: runId },
          withTranscriptWrite: async (write) => await write(),
        },
        fn,
      );
    const admittedRunContext = await admission.admit("embedded");
    const prepared = await run(() =>
      fixture.prepare({
        provider: "claude-cli",
        model: "sonnet",
        authProfileId: "anthropic:claude-cli",
        agentDir,
        sessionKey: target.sessionKey,
        runId,
        expectedWriterRunId: runId,
        admittedRunContext,
        bootstrapUserProfileId: profile,
        config,
        cliSessionBinding: binding,
        timeoutMs: 10_000,
      }),
    );
    cleanups.push(() => prepared.preparedBackend.cleanup?.());
    expect(prepared.cliHistoryWriter).toBeUndefined();
    expect(prepared.effectiveAuthProfileId).toBeUndefined();
    expect(loadSessionEntryReadOnly(target)?.cliHistoryBoundary).toBeUndefined();
    return { prepared, run, admission };
  };
  const receipt = async () => fs.readFile(path.join(dir, "native-hook.receipts"), "utf8");
  const first = await prepare(alice.id);
  await first.run(() => executePreparedCliRun(first.prepared));
  const allowedReceipt = await receipt();
  expect(allowedReceipt).toContain(raw);
  expect(allowedReceipt).toContain("ALICE_PRIVATE");
  const allowedHook: string = JSON.parse(allowedReceipt.trim()).response.response.hookSpecificOutput
    .additionalContext;
  console.info(
    "WORKSPACE_TRANSPORT_RECEIPT",
    JSON.stringify({
      transport: "synthetic-native-stdio",
      stage: "allowed-initial",
      receivedContextChars: allowedHook.length,
      receivedContextSha256: createHash("sha256").update(allowedHook).digest("hex"),
      currentProfilePresent: allowedHook.includes("ALICE_PRIVATE"),
      frozenWorkspacePresent: allowedHook.includes(raw),
    }),
  );
  // Existing v1 stored rendering may exceed today's budget; only its raw files are authoritative.
  const manager = await SessionManager.openAsync(target, dir);
  const saved = manager
    .getBranch()
    .findLast(
      (entry) => entry.type === "custom" && entry.customType === "openclaw:workspace-context:v1",
    );
  expect(saved?.type).toBe("custom");
  if (!saved || saved.type !== "custom") {
    throw new Error("Snapshot missing");
  }
  await first.run(() =>
    manager.appendCustomEntryAsync("openclaw:workspace-context:v1", {
      ...saved.data,
      context: {
        ...saved.data.context,
        contextFiles: [{ path: "AGENTS.md", content: raw + "LEGACY_UNBOUNDED" }],
      },
    }),
  );
  await fs.writeFile(path.join(dir, "AGENTS.md"), "EDITED_ON_DISK");
  await fs.rm(path.join(dir, "native-hook.receipts"));
  const prior = first.prepared;
  const binding = {
    sessionId: "synthetic-native",
    workspaceContextScopeHash: prior.workspaceContextScopeHash,
    authProfileId: prior.effectiveAuthProfileId,
    authEpoch: prior.authEpoch,
    authEpochVersion: prior.authEpochVersion,
    extraSystemPromptHash: prior.extraSystemPromptHash,
    messageToolPolicyHash: prior.messageToolPolicyHash,
    promptToolNamesHash: prior.promptToolNamesHash,
    cwdHash: prior.cwdHash,
    mcpConfigHash: prior.preparedBackend.mcpConfigHash,
    mcpResumeHash: prior.preparedBackend.mcpResumeHash,
  };
  await patchSessionEntryCore(target, (entry) => {
    setCliSessionBinding(entry, "claude-cli", binding);
    return entry;
  });
  const bounded = await prepare(alice.id, 1000, 1200, binding);
  expect(resolveCliSessionId(bounded.prepared.reusableCliSession)).toBe("synthetic-native");
  await bounded.run(() =>
    executePreparedCliRun(
      bounded.prepared,
      resolveCliSessionId(bounded.prepared.reusableCliSession),
    ),
  );
  const limited = await receipt();
  const sameProfileArgs: string[] = JSON.parse(limited.trim()).argv;
  expect(sameProfileArgs).toContain("--resume");
  expect(sameProfileArgs).toContain("synthetic-native");
  expect(limited).toContain("FROZEN_WORKSPACE_");
  expect(limited).not.toContain("LEGACY_UNBOUNDED");
  expect(limited).not.toContain("EDITED_ON_DISK");
  expect(limited).not.toContain("x".repeat(1000));
  expect(limited).toContain("truncated");
  const hook = JSON.parse(limited.trim()).response.response.hookSpecificOutput.additionalContext;
  const currentFiles = buildBootstrapContextForFiles(saved.data.context.bootstrapFiles, {
    config: bounded.prepared.params.config,
    agentId: "main",
  }).filter((file) => path.basename(file.path) !== "BOOTSTRAP.md");
  const expectedProject = buildProjectContextSection(
    prepareContextFilesForPrompt(currentFiles),
  ).join("\n");
  const receivedProject = String(hook).slice(String(hook).indexOf("# Project Context"));
  expect(Math.max(...currentFiles.map((file) => file.content.length))).toBeLessThanOrEqual(1000);
  expect(currentFiles.reduce((total, file) => total + file.content.length, 0)).toBeLessThanOrEqual(
    1200,
  );
  expect(receivedProject).toContain(expectedProject);
  console.info(
    "WORKSPACE_TRANSPORT_RECEIPT",
    JSON.stringify({
      transport: "synthetic-native-stdio",
      stage: "same-profile-restart",
      receivedContextChars: String(hook).length,
      receivedContextSha256: createHash("sha256").update(String(hook)).digest("hex"),
      renderedPerFileChars: currentFiles.map((file) => [
        path.basename(file.path),
        file.content.length,
      ]),
      renderedTotalFileChars: currentFiles.reduce((total, file) => total + file.content.length, 0),
      receivedMatchesCurrentRenderer: receivedProject.includes(expectedProject),
      priorStoredRenderingAbsent: !limited.includes("LEGACY_UNBOUNDED"),
      editedDiskAbsent: !limited.includes("EDITED_ON_DISK"),
      nativeResume:
        sameProfileArgs.includes("--resume") && sameProfileArgs.includes("synthetic-native"),
    }),
  );
  await fs.rm(path.join(dir, "native-hook.receipts"));
  const reassigned = await prepare(bob.id, 20_000, 30_000, binding);
  expect(reassigned.prepared.reusableCliSession).toEqual({
    mode: "invalidate",
    invalidatedReason: "workspace-context",
  });
  await reassigned.run(() =>
    executePreparedCliRun(
      reassigned.prepared,
      resolveCliSessionId(reassigned.prepared.reusableCliSession),
    ),
  );
  const reassignedReceipt = await receipt();
  expect(reassignedReceipt).toContain("BOB_PRIVATE");
  expect(reassignedReceipt).not.toContain("ALICE_PRIVATE");
  const reassignedRecord = JSON.parse(reassignedReceipt.trim());
  const reassignedArgs: string[] = reassignedRecord.argv;
  const reassignedHook: string =
    reassignedRecord.response.response.hookSpecificOutput.additionalContext;
  expect(reassignedArgs).not.toContain("--resume");
  expect(reassignedArgs).not.toContain("synthetic-native");
  console.info(
    "WORKSPACE_TRANSPORT_RECEIPT",
    JSON.stringify({
      transport: "synthetic-native-stdio",
      stage: "profile-reassigned",
      receivedContextChars: reassignedHook.length,
      receivedContextSha256: createHash("sha256").update(reassignedHook).digest("hex"),
      currentProfilePresent: reassignedHook.includes("BOB_PRIVATE"),
      priorProfileAbsent: !reassignedHook.includes("ALICE_PRIVATE"),
      nativeResume: reassignedArgs.includes("--resume"),
      priorNativeSessionArgAbsent: !reassignedArgs.includes("synthetic-native"),
    }),
  );
  await fs.rm(path.join(dir, "native-hook.receipts"));
  let release!: () => void;
  refreshRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshWasEntered = false;
  const entered = new Promise<void>((resolve) => {
    refreshEntered = () => {
      refreshWasEntered = true;
      resolve();
    };
  });
  reassigned.prepared.params.prompt = "COMPACT_FIXTURE";
  const execution = reassigned.run(() =>
    executePreparedCliRun(
      reassigned.prepared,
      resolveCliSessionId(reassigned.prepared.reusableCliSession),
    ),
  );
  const rejected = expect(execution).rejects.toThrow();
  await Promise.race([
    entered,
    execution.then(() => {
      throw new Error("Native execution completed before awaiting refresh");
    }),
  ]);
  reassigned.admission.close();
  const admissionClosedBeforeRelease = true;
  release();
  await rejected;
  const executionRejected = await execution.then(
    () => false,
    () => true,
  );
  const revokedReceipt = await receipt().then(
    () => ({ exists: true }),
    (error: unknown) => {
      expect(error).toMatchObject({ code: "ENOENT" });
      return { exists: false };
    },
  );
  expect(revokedReceipt).toEqual({ exists: false });
  console.info(
    "WORKSPACE_TRANSPORT_RECEIPT",
    JSON.stringify({
      transport: "synthetic-native-stdio",
      stage: "revoked-compact-refresh",
      refreshEntered: refreshWasEntered,
      admissionClosedBeforeRelease,
      executionRejected,
      childReceiptExists: revokedReceipt.exists,
    }),
  );
  expect(loadSessionEntryReadOnly(target)?.cliHistoryBoundary).toBeUndefined();
});
