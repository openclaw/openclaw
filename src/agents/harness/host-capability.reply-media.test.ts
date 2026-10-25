import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as mediaMime from "@openclaw/media-core/mime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { saveMediaBuffer } from "../../media/store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ensureSandboxWorkspaceForSession } from "../sandbox/context.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

afterEach(resetAgentRunRegistryForTest);
afterEach(() => vi.restoreAllMocks());

type MediaHost = Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>;
type TestState = Parameters<Parameters<typeof withOpenClawTestState>[1]>[0];
type HostOverrides = Partial<Parameters<typeof createAdmittedHostCapabilityTestFixture>[0]>;

async function withMediaHost(
  sessionId: string,
  run: (host: MediaHost, state: TestState) => Promise<void>,
  overrides: HostOverrides | ((state: TestState) => HostOverrides) = {},
) {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const host = await createAdmittedHostCapabilityTestFixture({
      runId: `run-${sessionId}`,
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      workspaceDir: state.workspaceDir,
      cwd: state.workspaceDir,
      config: {},
      ...(typeof overrides === "function" ? overrides(state) : overrides),
    });
    try {
      await run(host, state);
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  });
}

describe("agent harness reply media", () => {
  it.each(["missing", "pending", "delivered"] as const)(
    "selects current-input attachments by canonical completion after an earlier final reply (%s)",
    async (sourceReplyDeliveryState) => {
      await withMediaHost(
        "steered-reply-media",
        async (host) => {
          const currentText = "Current answer.\nMEDIA:./current.pdf";
          const currentAssistant = buildEmbeddedRunnerAssistant({
            content: [{ type: "text", text: currentText }],
          });
          const bytes = Buffer.from("%PDF-1.4\nCurrent input attachment\n%%EOF\n");
          const readWorkspaceFile = vi.fn(async () => bytes);
          const result = await host.hostCapabilities.prepareReplyMedia!({
            kind: "attempt",
            attempt: {
              ...makeEmbeddedRunnerAttempt({
                assistantTexts: [currentText],
                lastAssistant: currentAssistant,
                currentAttemptCompletedAssistant: currentAssistant,
                didSendViaMessagingTool: true,
                didDeliverSourceReplyViaMessageTool: true,
                sourceReplyDeliveryState,
                messagingToolSourceReplyPayloads: [
                  { text: "Earlier reply.", sourceReplyFinal: true },
                ],
              }),
              answerSegments: [
                {
                  textEnd: 0,
                  messageEnd: 1,
                  finalMessageStart: 1,
                  lastAssistant: buildEmbeddedRunnerAssistant({}),
                  sourceReplyDeliveryState: "delivered",
                },
              ],
            },
            workspaceRoot: "/remote-workspace",
            readWorkspaceFile,
          });
          assert(result.kind === "attempt", "expected prepared attempt media");
          if (sourceReplyDeliveryState !== "missing") {
            expect(readWorkspaceFile).not.toHaveBeenCalled();
            expect(result.preparedMedia).toEqual([]);
          } else {
            expect(readWorkspaceFile).toHaveBeenCalledOnce();
            expect(result.preparedMedia).toHaveLength(1);
            const outcome = result.preparedMedia[0]?.outcome;
            assert(outcome && "mediaUrl" in outcome, "expected staged current-input attachment");
            expect(outcome.trustedLocalMedia).toBe(true);
            expect(fs.readFileSync(outcome.mediaUrl)).toEqual(bytes);
          }
        },
        { sourceReplyDeliveryMode: "automatic" },
      );
    },
  );

  it("rejects Gateway sibling decoys while retaining managed media and HTTP references", async () => {
    await withMediaHost(
      "remote-reply-namespace",
      async (host, state) => {
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
        const readWorkspaceFile = vi.fn(async () => Buffer.from("unexpected remote read"));
        const result = await host.hostCapabilities.prepareReplyMedia!({
          kind: "payload",
          payload: {
            mediaUrls: [
              outside,
              path.relative(state.workspaceDir, outside),
              managedUrl,
              managed.path,
              httpUrl,
            ],
          },
          workspaceRoot: "/remote-workspace",
          readWorkspaceFile,
        });
        assert(result.kind === "payload", "expected prepared reply payload");
        const mediaUrls = result.payload.mediaUrls ?? [];
        expect(mediaUrls).toHaveLength(2);
        expect(mediaUrls[1]).toBe(httpUrl);
        expect(fs.readFileSync(mediaUrls[0] ?? "", "utf8")).toBe("managed attachment");
        expect(readWorkspaceFile).not.toHaveBeenCalled();
        const failures = getReplyPayloadMetadata(result.payload)?.assistantMediaFailures;
        expect(failures).toHaveLength(2);
        expect(failures?.map((failure) => failure.label)).toEqual([
          expect.stringMatching(/^Remote file: decoy-/),
          expect.stringMatching(/^Remote file: decoy-/),
        ]);
        expect(failures?.[0]?.label.length).toBeLessThanOrEqual(180);
        expect(failures?.[0]?.label).not.toContain(state.root);
      },
      { config: { tools: { allow: ["read"], fs: { workspaceOnly: false } } } },
    );
  });

  it("reads reply attachments from the remote sandbox instead of a stale Gateway sandbox", async () => {
    await withMediaHost(
      "reply-sandbox",
      async (host, state) => {
        const sandbox = await ensureSandboxWorkspaceForSession({
          config: host.attempt.config,
          sessionKey: host.attempt.sessionKey!,
          workspaceDir: state.workspaceDir,
        });
        assert(sandbox, "expected configured sandbox workspace");
        fs.writeFileSync(
          path.join(sandbox.workspaceDir, "artifact.txt"),
          "stale Gateway sandbox bytes",
        );
        const readWorkspaceFile = vi.fn(async () => Buffer.from("remote sandbox bytes"));
        const result = await host.hostCapabilities.prepareReplyMedia?.({
          kind: "payload",
          payload: { text: "MEDIA:./artifact.txt" },
          workspaceRoot: "/remote-workspace",
          readWorkspaceFile,
        });
        assert(result?.kind === "payload" && result.payload.mediaUrl, "expected remote attachment");
        expect(fs.readFileSync(result.payload.mediaUrl, "utf8")).toBe("remote sandbox bytes");
        expect(readWorkspaceFile).toHaveBeenCalledOnce();
      },
      (state) => ({
        config: {
          agents: {
            defaults: {
              sandbox: {
                mode: "all",
                scope: "session",
                workspaceAccess: "ro",
                workspaceRoot: state.path("sandboxes"),
              },
            },
          },
        },
      }),
    );
  });

  it("discards staged reply media when its host closes during MIME detection", async () => {
    await withMediaHost("reply-media-staging", async (host, state) => {
      const mediaDir = state.statePath("media", "outbound");
      fs.mkdirSync(mediaDir, { recursive: true });
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
      const operation = host.hostCapabilities.prepareReplyMedia!({
        kind: "payload",
        payload: { text: "MEDIA:./artifact.pdf" },
        readWorkspaceFile,
      });
      await expect(operation).rejects.toThrow(/no longer active|aborted/i);
      expect(fs.readdirSync(mediaDir)).toEqual([]);
      expect(inspected).toBe(true);
      expect(readWorkspaceFile).toHaveBeenCalledOnce();
    });
  });
});
