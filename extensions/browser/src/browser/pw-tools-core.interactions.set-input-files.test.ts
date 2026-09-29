import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS } from "./constants.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const readFile = vi.fn();
const stat = vi.fn();
const detectMime = vi.fn();
const resolveStrictExistingUploadPaths =
  vi.fn<typeof import("./paths.js").resolveStrictExistingUploadPaths>();
vi.mock("./paths.js", () => ({ resolveStrictExistingUploadPaths }));
vi.mock("node:fs/promises", () => ({ default: { readFile, stat } }));
vi.mock("openclaw/plugin-sdk/media-mime", () => ({ detectMime }));
const { setFileChooserFilesViaPlaywright, setInputFilesViaPlaywright } =
  await import("./pw-tools-core.interactions.js");
const session = getPwToolsCoreSessionMocks();
const canonical = "/private/tmp/openclaw/uploads/ok.txt";
const paths = ["/tmp/openclaw/uploads/ok.txt"];
const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
const payload = {
  name: "ok.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("upload contents"),
  lastModifiedMs: 1700000000000,
};
const nativeOptions = {
  timeout: DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS,
  signal: expect.any(AbortSignal),
};
const setInputFiles = vi.fn(async () => {});
const elementHandle = vi.fn(async () => {
  throw new Error("manual upload event dispatch is forbidden");
});
const page = {
  locator: () => ({ first: () => ({ setInputFiles, elementHandle }) }),
  url: () => "https://allowed.example/form",
};
function upload(options: Partial<Parameters<typeof setInputFilesViaPlaywright>[0]> = {}) {
  return setInputFilesViaPlaywright({ ...target, inputRef: "e7", paths, ...options });
}

beforeEach(() => {
  vi.clearAllMocks();
  setPwToolsCoreCurrentPage(page);
  setPwToolsCoreCurrentRefLocator({ setInputFiles, elementHandle });
  readFile.mockResolvedValue(payload.buffer);
  stat.mockResolvedValue({ size: payload.buffer.byteLength, mtimeMs: payload.lastModifiedMs });
  detectMime.mockResolvedValue(payload.mimeType);
  resolveStrictExistingUploadPaths.mockResolvedValue({ ok: true, paths: [canonical] });
});

describe("upload handoff", () => {
  it("converts guarded chooser uploads to payloads", async () => {
    const fileChooser = { setFiles: vi.fn(async () => {}) };
    await setFileChooserFilesViaPlaywright({
      ...target,
      cdpUrl: "https://browser.example/cdp",
      page: page as never,
      fileChooser: fileChooser as never,
      paths,
      timeoutMs: 250,
      ssrfPolicy: {},
    });
    expect(stat).toHaveBeenCalledWith(canonical);
    expect(readFile).toHaveBeenCalledWith(canonical);
    expect(fileChooser.setFiles).toHaveBeenCalledWith([payload], {
      timeout: 250,
      signal: expect.any(AbortSignal),
    });
  });

  it("sets resolved files once and leaves browser events to Playwright", async () => {
    await upload();
    expect(resolveStrictExistingUploadPaths).toHaveBeenCalledWith({ requestedPaths: paths });
    expect(session.refLocator).toHaveBeenCalledWith(page, "e7");
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(detectMime).not.toHaveBeenCalled();
    expect(setInputFiles).toHaveBeenCalledExactlyOnceWith([canonical], nativeOptions);
    expect(elementHandle).not.toHaveBeenCalled();
  });

  it("uses an octet-stream payload when mime detection has no answer", async () => {
    detectMime.mockResolvedValueOnce(undefined);
    await upload({ cdpUrl: "https://browser.example/cdp", ssrfPolicy: {} });
    expect(setInputFiles).toHaveBeenCalledWith(
      [{ ...payload, mimeType: "application/octet-stream" }],
      nativeOptions,
    );
  });

  it("checks aggregate payload size before reading any files", async () => {
    stat
      .mockResolvedValueOnce({ size: 30 * 1024 * 1024 })
      .mockResolvedValueOnce({ size: 30 * 1024 * 1024 });
    resolveStrictExistingUploadPaths.mockResolvedValueOnce({
      ok: true,
      paths: ["/private/tmp/openclaw/uploads/one.txt", "/private/tmp/openclaw/uploads/two.txt"],
    });
    await expect(
      upload({
        cdpUrl: "https://browser.example/cdp",
        paths: ["/tmp/openclaw/uploads/one.txt", "/tmp/openclaw/uploads/two.txt"],
        ssrfPolicy: {},
      }),
    ).rejects.toThrow("Cannot set buffer larger than 50Mb");
    expect(readFile).not.toHaveBeenCalled();
    expect(setInputFiles).not.toHaveBeenCalled();
  });

  it("keeps guarded local-filesystem uploads as paths inside the policy guard", async () => {
    await upload({
      browserFilesystemLocal: true,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(detectMime).not.toHaveBeenCalled();
    expect(setInputFiles).toHaveBeenCalledExactlyOnceWith([canonical], nativeOptions);
    expect(session.withPageNavigationRequestGuard).toHaveBeenCalledOnce();
    expect(session.assertPageNavigationCompletedSafely).toHaveBeenCalledOnce();
  });

  it("rejects paths outside the allowed directory before native upload", async () => {
    resolveStrictExistingUploadPaths.mockResolvedValueOnce({
      ok: false,
      error: "Invalid path: must stay within inbound media directory",
    });
    await expect(
      upload({
        inputRef: undefined,
        element: "input[type=file]",
        paths: ["/tmp/openclaw/uploads/missing.txt"],
      }),
    ).rejects.toThrow("Invalid path: must stay within inbound media directory");
    expect(setInputFiles).not.toHaveBeenCalled();
  });
});
