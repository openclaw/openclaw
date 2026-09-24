import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import * as fsSafe from "../../infra/fs-safe.js";
import { getMediaDir } from "../../media/store.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { runEmbeddedAttemptWithBackend } from "../embedded-agent-runner/run/backend.js";
import { makeEmbeddedRunnerAttempt } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { attachToolAllowlistIntersection } from "../tool-policy.js";
import { registerAgentWorkspaceAccess } from "../workspace-access.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { clearAgentHarnesses, registerAgentHarness } from "./registry.js";
import { createHarnessAttemptParams } from "./selection.test-support.js";
import type { AgentHarness } from "./types.js";

const trajectoryTempDirs = createTempDirTracker();
let admission: PreparedAgentRunAdmission;
let createAttemptParams: (config?: OpenClawConfig) => ReturnType<typeof createHarnessAttemptParams>;
beforeEach(async () => {
  clearAgentHarnesses();
  resetAgentRunRegistryForTest();
  admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: "attachment-test",
      agentId: "main",
      ingress: { kind: "system", boundary: "attachment-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef("attachment-test"),
  });
  const context = await admission.admit("plugin-harness", "attachment-test");
  createAttemptParams = (config) => createHarnessAttemptParams(context, config);
});
afterEach(async () => {
  admission.close();
  clearAgentHarnesses();
  resetAgentRunRegistryForTest();
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
  vi.unstubAllEnvs();
  trajectoryTempDirs.cleanup();
});

describe("registered harness input attachment preparation", () => {
  it.each(["before", "during"])(
    "fences input preparation when host capability closes %s an await",
    async (when) => {
      const attempt = {
        ...createAttemptParams(),
        workspaceDir: "/fixture/workspace",
        timeoutMs: 1_000,
        media: [{ path: "media://inbound/input.csv", contentType: "text/csv" }],
      };
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      host.setInputAttachmentReadAllowed(true);
      const prepare = host.capabilities.prepareInputAttachments;
      expect(prepare).toBeTypeOf("function");
      if (when === "before") {
        host.close();
      }
      const pending = prepare?.({
        placement: "local-host",
        maxChars: 60_000,
        assertCurrent: () => {},
      });
      if (when === "during") {
        host.close();
      }
      await expect(pending).rejects.toThrow("no longer active");
    },
  );

  it.each([
    "local",
    "projected",
    "bounded-inline",
    "metadata-sigils",
    "steering-sigils",
    "no-tools",
    "read-denied",
    "execution-intersection",
    "workspace-only",
    "remote-binding",
    "binding-during-open",
    "mime-denied",
    "hardlink",
    "metadata-budget",
    "note-budget",
    "no-budget",
  ])("prepares saved input only for eligible registered harness execution: %s", async (mode) => {
    const root = trajectoryTempDirs.make("harness-input-attachment-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const workspaceDir = path.join(root, "workspace");
    const sigils = mode.endsWith("sigils");
    const filePath = path.join(
      getMediaDir(),
      "inbound",
      sigils ? "inventory $deploy.csv" : "inventory.csv",
    );
    const fileName = '[$linked](skill://danger/SKILL.md) [@attached](plugin://fake) "雪"';
    const csv = "item,quantity\r\n雪,17\r\npear,23\r\n";
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.mkdir(workspaceDir);
    await fs.writeFile(filePath, csv);
    if (mode === "hardlink") {
      await fs.link(filePath, path.join(root, "other.csv"));
    }
    const mediaRef = sigils ? filePath : "media://inbound/inventory.csv";
    const media = [{ path: mediaRef, contentType: "text/csv", ...(sigils ? { fileName } : {}) }];
    const prompt = "Compute from the saved media://inbound/inventory.csv attachment.";
    const config: OpenClawConfig = {
      tools: {
        profile: "coding",
        ...(mode === "workspace-only" ? { fs: { workspaceOnly: true } } : {}),
        ...(mode === "read-denied" ? { deny: ["read"] } : {}),
      },
      ...(mode === "bounded-inline"
        ? { gateway: { http: { endpoints: { responses: { files: { maxChars: 1 } } } } } }
        : {}),
      ...(mode === "mime-denied"
        ? {
            gateway: {
              http: { endpoints: { responses: { files: { allowedMimes: ["application/pdf"] } } } },
            },
          }
        : {}),
    };
    let releaseDuringOpen: (() => void) | undefined;
    const originalOpen = fsSafe.openLocalFileSafely;
    const openSpy =
      mode === "binding-during-open"
        ? vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementation(async (request) => {
            const opened = await originalOpen(request);
            if (request.filePath === filePath) {
              releaseDuringOpen = registerAgentWorkspaceAccess(workspaceDir, {
                bridge: {
                  readFile: async () => Buffer.from("remote"),
                  writeFile: async () => {},
                  stat: async () => null,
                },
              });
            }
            return opened;
          })
        : undefined;
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (received) => {
      expect(received).not.toHaveProperty("inputAttachmentMedia");
      const prepare = received.hostCapabilities?.prepareInputAttachments;
      expect(prepare).toBeTypeOf("function");
      const preparation = prepare?.({
        placement: "local-host",
        ...(mode === "steering-sigils" ? { turn: { media } } : {}),
        maxChars:
          mode === "no-budget"
            ? 0
            : mode === "metadata-budget"
              ? 80
              : mode === "note-budget"
                ? JSON.stringify([{ reference: mediaRef, path: filePath }]).length
                : 60_000,
        assertCurrent: () => {},
      });
      if (mode === "binding-during-open") {
        await expect(preparation).rejects.toThrow("Workspace access changed");
        return makeEmbeddedRunnerAttempt({ agentHarnessId: "codex" });
      }
      const note = await preparation;
      if (sigils) {
        const metadata = note?.split("\n").find((line) => line.startsWith('[{"reference":'));
        expect(metadata).toBeDefined();
        expect(JSON.parse(metadata ?? "null")).toEqual([
          { reference: filePath, path: await fs.realpath(filePath), name: fileName },
        ]);
        expect(metadata).not.toMatch(/[$@]/);
        expect(await fs.readFile(filePath, "utf8")).toBe(csv);
      } else if (mode === "local" || mode === "projected" || mode === "bounded-inline") {
        expect(note).toContain(filePath);
        expect(await fs.readFile(filePath, "utf8")).toBe(csv);
      } else {
        expect(note).toBeUndefined();
      }
      expect(received.prompt).toBe(prompt);
      expect(received.transcriptPrompt).toBe(prompt);
      return makeEmbeddedRunnerAttempt({ agentHarnessId: "codex" });
    });
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true, priority: 100 }),
        conversationToolPolicySupport: "exact",
        runAttempt,
      },
      { ownerPluginId: "codex" },
    );
    const unregister =
      mode === "remote-binding"
        ? registerAgentWorkspaceAccess(workspaceDir, {
            bridge: {
              readFile: async () => Buffer.from("remote"),
              writeFile: async () => {},
              stat: async () => null,
            },
          })
        : undefined;
    try {
      await runEmbeddedAttemptWithBackend(
        {
          ...createAttemptParams(config),
          workspaceDir,
          prompt,
          transcriptPrompt: prompt,
          media: mode === "projected" ? undefined : media,
          disableTools: mode === "no-tools",
          toolExecutionAllow:
            mode === "execution-intersection"
              ? attachToolAllowlistIntersection(["read", "exec"], [["read", "exec"], ["exec"]])
              : undefined,
        },
        undefined,
        media,
      );
      expect(runAttempt).toHaveBeenCalledOnce();
      expect(media[0]?.path).toBe(mediaRef);
    } finally {
      unregister?.();
      releaseDuringOpen?.();
      openSpy?.mockRestore();
    }
  });
});
