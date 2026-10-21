import assert from "node:assert/strict";
import type { WebClient } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { WebMediaResult } from "openclaw/plugin-sdk/web-media";
import { afterEach, expect, it, vi } from "vitest";

const { loadMedia, guardedFetch } = vi.hoisted(() => ({
  loadMedia: vi.fn<() => Promise<WebMediaResult>>(),
  guardedFetch: vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

// mock-isolation: Synthetic media bytes avoid filesystem/network I/O during upload custody checks.
vi.mock("openclaw/plugin-sdk/outbound-media", () => ({ loadOutboundMediaFromUrl: loadMedia }));
// mock-isolation: Controlled HTTP settlement exercises upload authority without real requests.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));

const { uploadSlackFile } = await import("./client-delivery.js");

const uploadUrl = { ok: true, upload_url: "https://files.slack.com/upload", file_id: "F123" };
function uploadClient(getUploadURLExternal = vi.fn(async () => uploadUrl)) {
  const completeUploadExternal = vi.fn(async () => ({ ok: true }));
  return {
    client: { files: { getUploadURLExternal, completeUploadExternal } } as unknown as WebClient,
    getUploadURLExternal,
    completeUploadExternal,
  };
}
function uploadResponse(url: string) {
  return { response: new Response("ok"), finalUrl: url, release: async () => {} };
}

afterEach(() => vi.resetAllMocks());

it.each(["image/png", undefined])("preserves upload bytes and MIME %s", async (contentType) => {
  const backing = Buffer.from([0xfe, 0xfd, 1, 2, 3, 0xfc]);
  const buffer = backing.subarray(2, 5);
  const expectedBytes = Buffer.from([0, 0x80, 0xff]);
  loadMedia.mockResolvedValue({ buffer, contentType, kind: "image", fileName: "image.png" });
  const urlReady = createDeferred<typeof uploadUrl>();
  const { client, getUploadURLExternal, completeUploadExternal } = uploadClient(
    vi.fn(() => urlReady.promise),
  );
  let request: Request | undefined;
  guardedFetch.mockImplementation(async (params) => {
    backing.fill(0);
    request = new Request(params.url, params.init);
    return uploadResponse(params.url);
  });

  const upload = uploadSlackFile({ client, channelId: "C123", mediaUrl: "/tmp/image.png" });
  await vi.waitFor(() => expect(getUploadURLExternal).toHaveBeenCalledOnce());
  expect(guardedFetch).not.toHaveBeenCalled();
  expectedBytes.copy(buffer);
  urlReady.resolve(uploadUrl);
  await expect(upload).resolves.toBe("F123");
  expect(Buffer.from(await request!.arrayBuffer())).toEqual(expectedBytes);
  expect(request!.headers.get("content-type")).toBe(contentType ?? null);
  expect(completeUploadExternal).toHaveBeenCalledOnce();
});

it("revalidates authority at the external upload request boundary", async () => {
  loadMedia.mockResolvedValue({ buffer: Buffer.from("attachment"), kind: "document" });
  const { client, completeUploadExternal } = uploadClient();
  const preparation = createDeferred<void>();
  const rawUpload = vi.fn();
  guardedFetch.mockImplementation(async (params) => {
    await preparation.promise;
    params.beforeRequest?.();
    rawUpload();
    return uploadResponse(params.url);
  });
  let authorized = true;
  const upload = uploadSlackFile({
    client,
    channelId: "C123",
    mediaUrl: "/tmp/answer.txt",
    assertDirectAdapterHandoff: () => assert(authorized, "direct delivery is no longer active"),
  });
  await vi.waitFor(() => expect(guardedFetch).toHaveBeenCalledOnce());
  authorized = false;
  preparation.resolve();

  await expect(upload).rejects.toThrow();
  expect(rawUpload).not.toHaveBeenCalled();
  expect(completeUploadExternal).not.toHaveBeenCalled();
});
