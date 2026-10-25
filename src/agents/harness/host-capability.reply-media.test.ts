import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as mediaMime from "@openclaw/media-core/mime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { saveMediaBuffer } from "../../media/store.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ensureSandboxWorkspaceForSession } from "../sandbox/context.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let host: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>> | undefined;
beforeEach(async () => {
  host = undefined;
  state = await createOpenClawTestState({ layout: "state-only" });
});
afterEach(async () => {
  try {
    host?.closeHost();
    host?.closeAdmission();
    await state?.cleanup();
  } finally {
    resetAgentRunRegistryForTest();
    vi.restoreAllMocks();
  }
});
async function mediaHost(
  overrides: Partial<Parameters<typeof createAdmittedHostCapabilityTestFixture>[0]> = {},
) {
  host = await createAdmittedHostCapabilityTestFixture({
    runId: "reply-media",
    agentId: "main",
    sessionId: "reply-media",
    sessionKey: "agent:main:reply-media",
    config: {},
    workspaceDir: state.workspaceDir,
    cwd: state.workspaceDir,
    ...overrides,
  });
  return host.hostCapabilities;
}

it.each(["missing", "pending", "delivered"] as const)(
  "selects current-input media after an earlier final reply (%s)",
  async (sourceReplyDeliveryState) => {
    const caps = await mediaHost({ sourceReplyDeliveryMode: "automatic" });
    const text = "Current answer.\nMEDIA:./current.pdf";
    const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
    const bytes = Buffer.from("%PDF-1.4\nCurrent input attachment\n%%EOF\n");
    const readWorkspaceFile = vi.fn(async () => bytes);
    const result = await caps.prepareReplyMedia!({
      kind: "attempt",
      attempt: {
        ...makeEmbeddedRunnerAttempt({
          assistantTexts: [text],
          lastAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
          didSendViaMessagingTool: true,
          didDeliverSourceReplyViaMessageTool: true,
          sourceReplyDeliveryState,
          messagingToolSourceReplyPayloads: [{ text: "Earlier reply.", sourceReplyFinal: true }],
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
    assert(result.kind === "attempt");
    if (sourceReplyDeliveryState !== "missing") {
      expect(readWorkspaceFile).not.toHaveBeenCalled();
      expect(result.preparedMedia).toEqual([]);
    } else {
      expect(readWorkspaceFile).toHaveBeenCalledOnce();
      expect(result.preparedMedia).toHaveLength(1);
      const outcome = result.preparedMedia[0]?.outcome;
      assert(outcome && "mediaUrl" in outcome);
      expect(outcome.trustedLocalMedia).toBe(true);
      expect(fs.readFileSync(outcome.mediaUrl)).toEqual(bytes);
    }
  },
);

it("rejects Gateway sibling decoys but keeps managed media and HTTP references", async () => {
  const caps = await mediaHost({
    config: { tools: { allow: ["read"], fs: { workspaceOnly: false } } },
  });
  const outside = state.path("gateway-generated", `${"decoy-".repeat(30)}.txt`);
  fs.mkdirSync(path.dirname(outside));
  fs.writeFileSync(outside, "Gateway sibling must not be sent");
  const managed = await saveMediaBuffer(Buffer.from("managed attachment"), "text/plain", "inbound");
  const httpUrl = "https://example.com/attachment.pdf";
  const readWorkspaceFile = vi.fn(async () => Buffer.from("unexpected remote read"));
  const result = await caps.prepareReplyMedia!({
    kind: "payload",
    payload: {
      mediaUrls: [
        outside,
        path.relative(state.workspaceDir, outside),
        `media://inbound/${managed.id}`,
        managed.path,
        httpUrl,
      ],
    },
    workspaceRoot: "/remote-workspace",
    readWorkspaceFile,
  });
  assert(result.kind === "payload");
  const urls = result.payload.mediaUrls ?? [];
  expect(urls).toHaveLength(2);
  expect(urls[1]).toBe(httpUrl);
  expect(fs.readFileSync(urls[0] ?? "", "utf8")).toBe("managed attachment");
  expect(readWorkspaceFile).not.toHaveBeenCalled();
  const failures = getReplyPayloadMetadata(result.payload)?.assistantMediaFailures;
  expect(failures).toHaveLength(2);
  expect(failures?.map(({ label }) => label)).toEqual([
    expect.stringMatching(/^Remote file: decoy-/),
    expect.stringMatching(/^Remote file: decoy-/),
  ]);
  expect(failures?.[0]?.label.length).toBeLessThanOrEqual(180);
  expect(failures?.[0]?.label).not.toContain(state.root);
});

it("reads remote sandbox bytes instead of a stale Gateway sandbox", async () => {
  const config = {
    agents: {
      defaults: {
        sandbox: {
          mode: "all" as const,
          scope: "session" as const,
          workspaceAccess: "ro" as const,
          workspaceRoot: state.path("sandboxes"),
        },
      },
    },
  };
  const caps = await mediaHost({ config });
  const sandbox = await ensureSandboxWorkspaceForSession({
    config,
    sessionKey: "agent:main:reply-media",
    workspaceDir: state.workspaceDir,
  });
  assert(sandbox);
  fs.writeFileSync(path.join(sandbox.workspaceDir, "artifact.txt"), "stale Gateway sandbox bytes");
  const readWorkspaceFile = vi.fn(async () => Buffer.from("remote sandbox bytes"));
  const result = await caps.prepareReplyMedia!({
    kind: "payload",
    payload: { text: "MEDIA:./artifact.txt" },
    workspaceRoot: "/remote-workspace",
    readWorkspaceFile,
  });
  assert(result.kind === "payload" && result.payload.mediaUrl);
  expect(fs.readFileSync(result.payload.mediaUrl, "utf8")).toBe("remote sandbox bytes");
  expect(readWorkspaceFile).toHaveBeenCalledOnce();
});

it("discards staged media if its host closes during MIME detection", async () => {
  const caps = await mediaHost();
  const mediaDir = state.statePath("media", "outbound");
  fs.mkdirSync(mediaDir, { recursive: true });
  const readWorkspaceFile = vi.fn(async () => Buffer.from("%PDF-1.4\n%%EOF\n"));
  const detectMime = mediaMime.detectMime;
  let inspected = false;
  vi.spyOn(mediaMime, "detectMime").mockImplementation(async (params) => {
    const mime = await detectMime(params);
    expect(readWorkspaceFile).toHaveBeenCalledOnce();
    inspected = true;
    host!.closeHost();
    return mime;
  });
  await expect(
    caps.prepareReplyMedia!({
      kind: "payload",
      payload: { text: "MEDIA:./artifact.pdf" },
      readWorkspaceFile,
    }),
  ).rejects.toThrow(/no longer active|aborted/i);
  expect(fs.readdirSync(mediaDir)).toEqual([]);
  expect(inspected).toBe(true);
  expect(readWorkspaceFile).toHaveBeenCalledOnce();
});
