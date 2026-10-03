import fs from "node:fs";
import path from "node:path";
import * as mediaMime from "@openclaw/media-core/mime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { saveMediaBuffer } from "../../media/store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ensureSandboxWorkspaceForSession } from "../sandbox/context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetAgentRunRegistryForTest);
afterEach(() => vi.restoreAllMocks());

describe("agent harness reply media", () => {
  it("rejects Gateway sibling decoys while retaining managed media and HTTP references", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const outside = state.path("gateway-generated", `${"decoy-".repeat(30)}.txt`);
      fs.mkdirSync(path.dirname(outside));
      fs.writeFileSync(outside, "Gateway sibling must not be sent");
      const managed = await saveMediaBuffer(
        Buffer.from("managed attachment"),
        "text/plain",
        "inbound",
      );
      const managedUrl = `media://inbound/${managed.id}`;
      const httpUrl = "https://example.com/attachment.pdf";
      const host = await createAdmittedHostCapabilityTestFixture({
        runId: "run-remote-reply-namespace",
        agentId: "main",
        sessionId: "remote-reply-namespace",
        sessionKey: "agent:main:remote-reply-namespace",
        workspaceDir: state.workspaceDir,
        cwd: state.workspaceDir,
        config: { tools: { allow: ["read"], fs: { workspaceOnly: false } } },
      });
      const readWorkspaceFile = vi.fn(async () => Buffer.from("unexpected remote read"));
      try {
        const result = await host.hostCapabilities.prepareReplyMedia!({
          kind: "payload",
          payload: { mediaUrls: [outside, managedUrl, managed.path, httpUrl] },
          workspaceRoot: "/remote-workspace",
          readWorkspaceFile,
        });
        if (result.kind !== "payload") {
          throw new Error("expected prepared reply payload");
        }
        const mediaUrls = result.payload.mediaUrls ?? [];
        expect(mediaUrls).toHaveLength(2);
        expect(mediaUrls[1]).toBe(httpUrl);
        expect(fs.readFileSync(mediaUrls[0] ?? "", "utf8")).toBe("managed attachment");
        expect(readWorkspaceFile).not.toHaveBeenCalled();
        const failures = getReplyPayloadMetadata(result.payload)?.assistantMediaFailures;
        expect(failures).toHaveLength(1);
        expect(failures?.[0]?.label).toMatch(/^Remote file outside workspace: decoy-/);
        expect(failures?.[0]?.label.length).toBeLessThanOrEqual(180);
        expect(failures?.[0]?.label).not.toContain(state.root);
      } finally {
        host.closeHost();
        host.closeAdmission();
      }
    });
  });

  it("reads reply attachments from the remote sandbox instead of a stale Gateway sandbox", async () => {
    const fixture = tempDirs.make("openclaw-reply-sandbox-");
    const workspaceDir = path.join(fixture, "workspace");
    fs.mkdirSync(workspaceDir);
    const attempt = {
      runId: "run-reply-sandbox",
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      cwd: workspaceDir,
      workspaceDir,
      config: {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              scope: "session",
              workspaceAccess: "ro",
              workspaceRoot: path.join(fixture, "sandboxes"),
            },
          },
        },
      } satisfies OpenClawConfig,
    };
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: attempt.config,
      sessionKey: attempt.sessionKey,
      workspaceDir,
    });
    if (!sandbox) {
      throw new Error("expected configured sandbox workspace");
    }
    fs.writeFileSync(
      path.join(sandbox.workspaceDir, "artifact.txt"),
      "stale Gateway sandbox bytes",
    );
    const host = await createAdmittedHostCapabilityTestFixture(attempt);
    try {
      const readWorkspaceFile = vi.fn(async () => Buffer.from("remote sandbox bytes"));
      const result = await host.hostCapabilities.prepareReplyMedia?.({
        kind: "payload",
        payload: { text: "MEDIA:./artifact.txt" },
        workspaceRoot: "/remote-workspace",
        readWorkspaceFile,
      });
      expect(result?.kind).toBe("payload");
      if (result?.kind !== "payload" || !result.payload.mediaUrl) {
        throw new Error("expected prepared remote attachment");
      }
      expect(fs.readFileSync(result.payload.mediaUrl, "utf8")).toBe("remote sandbox bytes");
      expect(readWorkspaceFile).toHaveBeenCalledOnce();
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  });

  it("discards staged reply media when its host closes during MIME detection", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const mediaDir = state.statePath("media", "outbound");
      fs.mkdirSync(mediaDir, { recursive: true });
      const host = await createAdmittedHostCapabilityTestFixture({
        runId: "run-reply-media-staging",
        agentId: "main",
        sessionId: "reply-media-staging",
        sessionKey: "agent:main:reply-media-staging",
        workspaceDir: state.workspaceDir,
        cwd: state.workspaceDir,
        config: {},
      });
      const bytes = Buffer.from("%PDF-1.4\n%%EOF\n");
      const readWorkspaceFile = vi.fn(async () => bytes);
      const detectMime = mediaMime.detectMime;
      let inspected = false;
      vi.spyOn(mediaMime, "detectMime").mockImplementation(async (params) => {
        const mime = await detectMime(params);
        expect(readWorkspaceFile).toHaveBeenCalledOnce();
        inspected = true;
        host.closeHost();
        return mime;
      });
      try {
        const operation = host.hostCapabilities.prepareReplyMedia!({
          kind: "payload",
          payload: { text: "MEDIA:./artifact.pdf" },
          readWorkspaceFile,
        });
        await expect(operation).rejects.toThrow(/no longer active|aborted/i);
        expect(fs.readdirSync(mediaDir)).toEqual([]);
        expect(inspected).toBe(true);
        expect(readWorkspaceFile).toHaveBeenCalledOnce();
      } finally {
        host.closeHost();
        host.closeAdmission();
      }
    });
  });
});
