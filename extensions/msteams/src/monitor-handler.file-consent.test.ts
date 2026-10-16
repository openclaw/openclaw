import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { runMSTeamsFileConsentInvokeHandler } from "./file-consent-invoke.js";
import { getPendingUploadFs, storePendingUploadFs } from "./pending-uploads-fs.js";
import { getPendingUpload, removePendingUpload, storePendingUpload } from "./pending-uploads.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const fileConsentMockState = vi.hoisted(() => ({
  uploadToConsentUrl: vi.fn(),
}));

vi.mock("./file-consent.js", async (original) => ({
  ...(await original<typeof import("./file-consent.js")>()),
  uploadToConsentUrl: fileConsentMockState.uploadToConsentUrl,
}));

function createRuntimeStub(stateDir?: string): PluginRuntime {
  return {
    state: {
      openKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests("msteams", options),
      resolveStateDir: (env?: NodeJS.ProcessEnv) =>
        env?.OPENCLAW_STATE_DIR?.trim() || (stateDir ?? path.join(os.homedir(), ".openclaw")),
    },
  } as unknown as PluginRuntime;
}

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
};

const createdUploadIds = new Set<string>();

afterEach(() => {
  createdUploadIds.forEach(removePendingUpload);
  createdUploadIds.clear();
});

function createInvokeContext(params: {
  conversationId: string;
  uploadId: string;
  action: "accept" | "decline";
  file?: { name: string; contentUrl: string; uniqueId: string; fileType: string };
}) {
  const sendActivity = vi.fn(async () => ({ id: "activity-id" }));
  const updateActivity = vi.fn(async () => ({ id: "activity-id" }));
  const uploadInfo =
    params.action === "accept"
      ? {
          name: "secret.txt",
          uploadUrl: "https://upload.example.com/put",
          contentUrl: "https://content.example.com/file",
          uniqueId: "unique-id",
          fileType: "txt",
          ...params.file,
        }
      : undefined;
  return {
    context: {
      activity: {
        type: "invoke",
        name: "fileConsent/invoke",
        conversation: { id: params.conversationId },
        value: {
          type: "fileUpload",
          action: params.action,
          uploadInfo,
          context: { uploadId: params.uploadId },
        },
      },
      sendActivity,
      sendActivities: async () => [],
      updateActivity,
    } as unknown as MSTeamsTurnContext,
    sendActivity,
    updateActivity,
  };
}

function createConsentInvokeHarness(params: {
  invokeConversationId?: string;
  action?: "accept" | "decline";
  consentCardActivityId?: string;
}) {
  const uploadId = storePendingUpload({
    buffer: Buffer.from("TOP_SECRET_VICTIM_FILE\n"),
    filename: "secret.txt",
    contentType: "text/plain",
    conversationId: "19:victim@thread.v2",
    consentCardActivityId: params.consentCardActivityId,
  });
  createdUploadIds.add(uploadId);
  const invoke = createInvokeContext({
    conversationId: params.invokeConversationId ?? "19:victim@thread.v2;messageid=abc123",
    uploadId,
    action: params.action ?? "accept",
  });
  return { uploadId, ...invoke };
}

beforeEach(() => {
  setMSTeamsRuntime(createRuntimeStub());
  vi.clearAllMocks();
  fileConsentMockState.uploadToConsentUrl.mockReset().mockResolvedValue(undefined);
});

describe("msteams file consent invoke authz", () => {
  it("rejects malformed consent without logging its content", async () => {
    const { context, sendActivity } = createInvokeContext({
      conversationId: "19:victim@thread.v2",
      uploadId: "invalid-consent",
      action: "decline",
    });
    const privateText = "synthetic private consent content";
    context.activity.value = { type: "unexpected", text: privateText };

    await runMSTeamsFileConsentInvokeHandler(context, log);

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(sendActivity).not.toHaveBeenCalled();
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain(privateText);
    expect(log.debug).toHaveBeenCalledWith("invalid file consent invoke");
  });

  it("calls updateActivity to replace the consent card when consentCardActivityId is set", async () => {
    const { uploadId, context, sendActivity, updateActivity } = createConsentInvokeHarness({
      consentCardActivityId: "consent-card-activity-id-123",
    });

    await runMSTeamsFileConsentInvokeHandler(context, log);

    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);

    expect(updateActivity).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: "consent-card-activity-id-123",
        type: "message",
        attachments: expect.arrayContaining([
          expect.objectContaining({
            contentType: "application/vnd.microsoft.teams.card.file.info",
          }),
        ]),
      }),
    );
    expect(sendActivity).not.toHaveBeenCalled();
    expect(getPendingUpload(uploadId)).toBeUndefined();
  });

  it("still completes upload if updateActivity throws", async () => {
    const { uploadId, context, updateActivity } = createConsentInvokeHarness({
      consentCardActivityId: "consent-card-activity-id-fail",
    });
    updateActivity.mockRejectedValueOnce(new Error("Teams API error"));

    await runMSTeamsFileConsentInvokeHandler(context, log);

    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);
    expect(getPendingUpload(uploadId)).toBeUndefined();
    expect(updateActivity).toHaveBeenCalledTimes(1);
  });

  it.each(["accept", "decline"] as const)(
    "rejects cross-conversation %s and keeps the pending upload",
    async (action) => {
      const { uploadId, context, sendActivity } = createConsentInvokeHarness({
        invokeConversationId: "19:attacker@thread.v2",
        action,
      });
      await runMSTeamsFileConsentInvokeHandler(context, log);
      if (action === "accept") {
        expect(sendActivity).toHaveBeenCalledWith(
          "The file upload request has expired. Please try sending the file again.",
        );
      } else {
        expect(sendActivity).not.toHaveBeenCalled();
      }
      expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
      expect(getPendingUpload(uploadId)).toMatchObject({
        conversationId: "19:victim@thread.v2",
        filename: "secret.txt",
        contentType: "text/plain",
      });
    },
  );
});

describe("msteams file consent invoke FS fallback", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-invoke-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    setMSTeamsRuntime(createRuntimeStub(tmpDir));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // tmp dir may already be gone
    }
  });

  it("reads pending upload from FS store when in-memory store is empty (cross-process CLI path)", async () => {
    const uploadId = "cli-upload-id-123";
    const conversationId = "19:victim@thread.v2";
    await storePendingUploadFs({
      id: uploadId,
      buffer: Buffer.from("CLI PAYLOAD"),
      filename: "cli.bin",
      contentType: "application/octet-stream",
      conversationId,
    });

    expect(getPendingUpload(uploadId)).toBeUndefined();

    const { context } = createInvokeContext({
      conversationId: `${conversationId};messageid=abc123`,
      uploadId,
      action: "accept",
      file: {
        name: "cli.bin",
        contentUrl: "https://content.example.com/cli.bin",
        uniqueId: "unique-cli",
        fileType: "bin",
      },
    });

    await runMSTeamsFileConsentInvokeHandler(context, log);

    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://upload.example.com/put" }),
    );

    expect(await getPendingUploadFs(uploadId)).toBeUndefined();
  });

  it("cleans up FS entry on decline even when in-memory store is empty", async () => {
    const uploadId = "cli-decline-id";
    const conversationId = "19:victim@thread.v2";
    await storePendingUploadFs({
      id: uploadId,
      buffer: Buffer.from("DECLINED"),
      filename: "decline.txt",
      contentType: "text/plain",
      conversationId,
    });

    const { context } = createInvokeContext({
      conversationId: `${conversationId};messageid=abc123`,
      uploadId,
      action: "decline",
    });

    await runMSTeamsFileConsentInvokeHandler(context, log);

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(await getPendingUploadFs(uploadId)).toBeUndefined();
  });
});
