import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS as downloadTimeout } from "./constants.js";
import * as harness from "./pw-tools-core.test-harness.js";

harness.installPwToolsCoreTestHooks();
const readFile = vi.fn(),
  stat = vi.fn(),
  detectMime = vi.fn();
const resolvePaths = vi.fn<typeof import("./paths.js").resolveStrictExistingUploadPaths>();
// mock-isolation: Upload cases supply canonical paths without reading host upload directories.
vi.mock("./paths.js", () => ({ resolveStrictExistingUploadPaths: resolvePaths }));
vi.mock("node:fs/promises", () => ({ default: { readFile, stat } }));
vi.mock("openclaw/plugin-sdk/media-mime", () => ({ detectMime }));
const { setFileChooserFilesViaPlaywright, setInputFilesViaPlaywright } =
  await import("./pw-tools-core.interactions.content.js");
const session = harness.getPwToolsCoreSessionMocks();
const canonical = "/private/tmp/openclaw/uploads/a.txt";
const paths = ["/tmp/openclaw/uploads/a.txt"];
const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
const remote = { cdpUrl: "https://browser.example/cdp", ssrfPolicy: {} };
const extension = {
  browserFilesystemLocal: false,
  uploadPathsFallbackOnPayloadLimit: true,
  ssrfPolicy: {},
};
const payload = { name: "a.txt", mimeType: "text/plain", buffer: Buffer.of(1), lastModifiedMs: 1 };
const nativeOptions = (timeout = downloadTimeout) => ({ timeout, signal: expect.any(AbortSignal) });
const fileStats = (size: number) => ({ size, mtimeMs: payload.lastModifiedMs });
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
const expectUpload = (files: (string | typeof payload)[]) =>
  expect(setInputFiles).toHaveBeenCalledExactlyOnceWith(files, nativeOptions());

beforeEach(() => {
  vi.clearAllMocks();
  harness.setPwToolsCoreCurrentPage(page);
  harness.setPwToolsCoreCurrentRefLocator({ setInputFiles, elementHandle });
  readFile.mockResolvedValue(payload.buffer);
  stat.mockResolvedValue(fileStats(payload.buffer.byteLength));
  detectMime.mockResolvedValue(payload.mimeType);
  resolvePaths.mockResolvedValue({ ok: true, paths: [canonical] });
});

it("converts guarded chooser uploads to payloads", async () => {
  const fileChooser = { setFiles: vi.fn(async () => {}) };
  await setFileChooserFilesViaPlaywright({
    ...target,
    ...remote,
    page: page as never,
    fileChooser: fileChooser as never,
    paths,
    timeoutMs: 250,
  });
  expect(stat).toHaveBeenCalledWith(canonical);
  expect(readFile).toHaveBeenCalledWith(canonical);
  expect(fileChooser.setFiles).toHaveBeenCalledWith([payload], nativeOptions(250));
});

it("uses an octet-stream payload when mime detection has no answer", async () => {
  detectMime.mockResolvedValueOnce(undefined);
  await upload(remote);
  expectUpload([{ ...payload, mimeType: "application/octet-stream" }]);
});

it("checks aggregate payload size before reading any files", async () => {
  const largeFile = fileStats(30 * 1024 * 1024);
  stat.mockResolvedValueOnce(largeFile).mockResolvedValueOnce(largeFile);
  const requested = ["one.txt", "two.txt"].map((name) => `/tmp/openclaw/uploads/${name}`);
  resolvePaths.mockResolvedValueOnce({
    ok: true,
    paths: requested.map((file) => `/private${file}`),
  });
  await expect(upload({ ...remote, paths: requested })).rejects.toThrow(
    "Cannot set buffer larger than 50Mb",
  );
  expect(readFile).not.toHaveBeenCalled();
  expect(setInputFiles).not.toHaveBeenCalled();
});

it.each([46, 47, 48, 50])("uses safe %i MiB extension handoff", async (mib) => {
  stat.mockResolvedValueOnce(fileStats(mib * 1024 * 1024));
  await upload(extension);
  expect(readFile.mock.calls).toEqual(mib === 46 ? [[canonical]] : []);
  expectUpload([mib === 46 ? payload : canonical]);
});

it("keeps guarded local-filesystem uploads as paths inside the policy guard", async () => {
  await upload({
    browserFilesystemLocal: true,
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
  });
  for (const unused of [stat, readFile, detectMime, elementHandle]) {
    expect(unused).not.toHaveBeenCalled();
  }
  expectUpload([canonical]);
  expect(resolvePaths).toHaveBeenCalledWith({ requestedPaths: paths });
  expect(session.refLocator).toHaveBeenCalledWith(page, "e7");
  expect(session.withPageNavigationRequestGuard).toHaveBeenCalledOnce();
  expect(session.assertPageNavigationCompletedSafely).toHaveBeenCalledOnce();
});

it("rejects paths outside the allowed directory before native upload", async () => {
  const error = "Invalid path: must stay within inbound media directory";
  resolvePaths.mockResolvedValueOnce({ ok: false, error });
  const missing = "/tmp/openclaw/uploads/missing.txt";
  const selector = { inputRef: undefined, element: "input[type=file]", paths: [missing] };
  await expect(upload(selector)).rejects.toThrow(error);
  expect(setInputFiles).not.toHaveBeenCalled();
});
