import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { prepareFileConsentActivityFs } from "./file-consent-helpers.js";
import {
  registerMSTeamsHandlers,
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
} from "./monitor-handler.js";
import {
  createActivityHandler,
  createMSTeamsMessageHandlerDeps,
} from "./monitor-handler.test-helpers.js";
import {
  createPendingUploadFsStore,
  PENDING_UPLOAD_FS_TTL_MS,
  type PendingUploadFsStore,
} from "./pending-uploads-fs.js";
import { clearPendingUploads } from "./pending-uploads.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const fileConsentMockState = vi.hoisted(() => ({
  uploadToConsentUrl: vi.fn(),
}));

vi.mock("./file-consent.js", async () => {
  const actual = await vi.importActual<typeof import("./file-consent.js")>("./file-consent.js");
  return {
    ...actual,
    uploadToConsentUrl: fileConsentMockState.uploadToConsentUrl,
  };
});

const runtimeStub: PluginRuntime = {
  logging: {
    shouldLogVerbose: () => false,
  },
  channel: {
    debounce: {
      resolveInboundDebounceMs: () => 0,
      createInboundDebouncer: () => ({
        enqueue: async () => {},
      }),
    },
  },
} as unknown as PluginRuntime;

describe("msteams fs-backed pending uploads store", () => {
  let tmpDir: string;
  let store: PendingUploadFsStore;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-pending-"));
    store = createPendingUploadFsStore({ storeDir: tmpDir });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists the buffer and metadata across separate store handles", async () => {
    const buffer = Buffer.from("file contents for cross-process lookup");
    const id = await store.store({
      buffer,
      filename: "report.pdf",
      contentType: "application/pdf",
      conversationId: "conv-abc",
    });

    // Build a fresh store that only shares the on-disk directory. This
    // simulates the CLI sender writing the upload and the gateway monitor
    // reading it back from a separate process.
    const reader = createPendingUploadFsStore({ storeDir: tmpDir });
    const hit = await reader.get(id);

    expect(hit).toBeDefined();
    expect(hit?.entry.filename).toBe("report.pdf");
    expect(hit?.entry.contentType).toBe("application/pdf");
    expect(hit?.entry.conversationId).toBe("conv-abc");
    expect(hit?.entry.size).toBe(buffer.length);
    expect(hit?.buffer.equals(buffer)).toBe(true);
  });

  it("returns undefined for unknown and malformed ids", async () => {
    expect(await store.get(undefined)).toBeUndefined();
    expect(await store.get("")).toBeUndefined();
    expect(await store.get("not-a-uuid")).toBeUndefined();
    // UUID-shaped but nonexistent
    expect(await store.get("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("remove deletes both the blob and index row", async () => {
    const id = await store.store({
      buffer: Buffer.from("bye"),
      filename: "bye.txt",
      conversationId: "conv-1",
    });
    expect(await store.count()).toBe(1);

    await store.remove(id);
    expect(await store.count()).toBe(0);
    expect(await store.get(id)).toBeUndefined();

    const blobFiles = (await fs.promises.readdir(tmpDir)).filter((f) => f.endsWith(".blob"));
    expect(blobFiles).toHaveLength(0);
  });

  it("remove is a no-op for undefined and malformed ids", async () => {
    await store.store({
      buffer: Buffer.from("keep me"),
      filename: "k.txt",
      conversationId: "conv-1",
    });
    await expect(store.remove(undefined)).resolves.toBeUndefined();
    await expect(store.remove("../etc/passwd")).resolves.toBeUndefined();
    expect(await store.count()).toBe(1);
  });

  it("prunes expired entries on read and removes their blob files", async () => {
    const shortTtl = createPendingUploadFsStore({ storeDir: tmpDir, ttlMs: 10 });
    const id = await shortTtl.store({
      buffer: Buffer.from("expires"),
      filename: "e.txt",
      conversationId: "conv-1",
    });
    // Wait past the TTL without depending on fake timers (FS APIs are real)
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await shortTtl.get(id)).toBeUndefined();
    expect(await shortTtl.count()).toBe(0);

    const blobFiles = (await fs.promises.readdir(tmpDir)).filter((f) => f.endsWith(".blob"));
    expect(blobFiles).toHaveLength(0);
  });

  it("handles missing blob by dropping the stale index entry", async () => {
    const id = await store.store({
      buffer: Buffer.from("orphan test"),
      filename: "orphan.txt",
      conversationId: "conv-1",
    });

    // Simulate a corrupted store: blob gone, index still references the id.
    await fs.promises.unlink(path.join(tmpDir, `${id}.blob`));

    expect(await store.get(id)).toBeUndefined();
    expect(await store.count()).toBe(0);
  });

  it("exposes the shared TTL constant", () => {
    // Sanity check that the public TTL constant matches the documented 5
    // minute window. Regressions here would silently change cross-process
    // expiry behavior.
    expect(PENDING_UPLOAD_FS_TTL_MS).toBe(5 * 60 * 1000);
  });
});

function createDeps(pendingUploadFsStore: PendingUploadFsStore): MSTeamsMessageHandlerDeps {
  const deps = createMSTeamsMessageHandlerDeps({
    cfg: {} as OpenClawConfig,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
  });
  return { ...deps, pendingUploadFsStore };
}

function createInvokeContext(params: {
  conversationId: string;
  uploadId: string;
  action: "accept" | "decline";
}): { context: MSTeamsTurnContext; sendActivity: ReturnType<typeof vi.fn> } {
  const sendActivity = vi.fn(async () => ({ id: "activity-id" }));
  const uploadInfo =
    params.action === "accept"
      ? {
          name: "report.pdf",
          uploadUrl: "https://upload.example.com/put",
          contentUrl: "https://content.example.com/file",
          uniqueId: "unique-id",
          fileType: "pdf",
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
    } as unknown as MSTeamsTurnContext,
    sendActivity,
  };
}

describe("msteams file consent handler (cross-process fs fallback)", () => {
  let tmpDir: string;
  let fsStore: PendingUploadFsStore;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-fc-"));
    fsStore = createPendingUploadFsStore({ storeDir: tmpDir });
    setMSTeamsRuntime(runtimeStub);
    clearPendingUploads();
    fileConsentMockState.uploadToConsentUrl.mockReset();
    fileConsentMockState.uploadToConsentUrl.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("registers a run wrapper that intercepts fileConsent/invoke activities", () => {
    const handler = createActivityHandler();
    const originalRun = handler.run;
    const wrapped = registerMSTeamsHandlers(handler, createDeps(fsStore));
    expect(wrapped.run).toBeDefined();
    // registerMSTeamsHandlers should replace the original run with a wrapper
    // that knows how to intercept invoke activities.
    expect(wrapped.run).not.toBe(originalRun);
  });

  it("uploads when the pending file lives only in the fs store (CLI cross-process path)", async () => {
    // Simulate the CLI sender process: it writes the pending upload to the
    // shared fs store and then exits. The monitor never saw an in-memory
    // storePendingUpload call.
    const { uploadId } = await prepareFileConsentActivityFs({
      media: {
        buffer: Buffer.from("file contents"),
        filename: "report.pdf",
        contentType: "application/pdf",
      },
      conversationId: "19:victim@thread.v2",
      store: fsStore,
    });

    const handler = registerMSTeamsHandlers(
      createActivityHandler(),
      createDeps(fsStore),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const { context, sendActivity } = createInvokeContext({
      conversationId: "19:victim@thread.v2;messageid=abc123",
      uploadId,
      action: "accept",
    });

    await handler.run(context);

    expect(sendActivity).toHaveBeenCalledWith(expect.objectContaining({ type: "invokeResponse" }));
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://upload.example.com/put",
        contentType: "application/pdf",
      }),
    );
    // After a successful upload the fs store should be drained so repeat
    // invokes cannot re-trigger the upload.
    expect(await fsStore.get(uploadId)).toBeUndefined();
  });

  it("drops the fs-backed pending upload when the user declines", async () => {
    const { uploadId } = await prepareFileConsentActivityFs({
      media: {
        buffer: Buffer.from("file contents"),
        filename: "report.pdf",
        contentType: "application/pdf",
      },
      conversationId: "19:victim@thread.v2",
      store: fsStore,
    });
    expect(await fsStore.count()).toBe(1);

    const handler = registerMSTeamsHandlers(
      createActivityHandler(),
      createDeps(fsStore),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const { context } = createInvokeContext({
      conversationId: "19:victim@thread.v2",
      uploadId,
      action: "decline",
    });

    await handler.run(context);

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(await fsStore.get(uploadId)).toBeUndefined();
    expect(await fsStore.count()).toBe(0);
  });

  it("shows an expired message when neither store has a pending upload", async () => {
    const handler = registerMSTeamsHandlers(
      createActivityHandler(),
      createDeps(fsStore),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const { context, sendActivity } = createInvokeContext({
      conversationId: "19:victim@thread.v2",
      // Valid UUID format but never stored in either store.
      uploadId: "11111111-2222-4333-8444-555555555555",
      action: "accept",
    });

    await handler.run(context);

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(sendActivity).toHaveBeenCalledWith(
      "The file upload request has expired. Please try sending the file again.",
    );
  });

  it("rejects cross-conversation accept for an fs-backed pending upload", async () => {
    const { uploadId } = await prepareFileConsentActivityFs({
      media: {
        buffer: Buffer.from("secret contents"),
        filename: "secret.pdf",
        contentType: "application/pdf",
      },
      conversationId: "19:victim@thread.v2",
      store: fsStore,
    });

    const handler = registerMSTeamsHandlers(
      createActivityHandler(),
      createDeps(fsStore),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const { context, sendActivity } = createInvokeContext({
      // Attacker tries to accept from a different conversation.
      conversationId: "19:attacker@thread.v2",
      uploadId,
      action: "accept",
    });

    await handler.run(context);

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(sendActivity).toHaveBeenCalledWith(
      "The file upload request has expired. Please try sending the file again.",
    );
    // Pending upload must survive the attempted cross-conversation accept.
    expect(await fsStore.get(uploadId)).toBeDefined();
  });
});
