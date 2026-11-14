/* @vitest-environment jsdom */
import type { FeatureClient, FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import { afterEach, expect, it, vi } from "vitest";
import type { FullOutputContract } from "./contract.js";
import { originalDownload } from "./evidence-view.js";

const source = {
  path: "artifacts/planning.txt",
  sha256: "a".repeat(64),
  filename: "planning.txt",
  verified: true,
  excerpt: "Plan",
  excerptTruncated: false,
};
function control() {
  const feature: FeatureClient<FullOutputContract> = {
    async invoke() {
      throw new Error("Unexpected feature request");
    },
    on: () => () => {},
    watch: () => () => {},
  };
  const invoke = vi.spyOn(feature, "invoke").mockResolvedValue({
    data: btoa("Plan"),
    offset: 0,
    nextOffset: null,
    size: 4,
    sha256: source.sha256,
    filename: source.filename,
    mediaType: "text/plain",
  } satisfies FeatureOutput<FullOutputContract, "attachment">);
  const view = originalDownload(
    feature,
    "project_test",
    source,
    () => true,
    (value) => value,
  );
  document.body.append(view.download, view.status);
  return { ...view, invoke };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window.showSaveFilePicker;
  document.body.replaceChildren();
});

it("reports only a browser handoff when no file writer can confirm saving", async () => {
  vi.useFakeTimers();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:synthetic"),
    revokeObjectURL: vi.fn(),
  });
  const { download, status, invoke } = control();
  download.click();
  expect(download.disabled).toBe(true);
  await vi.runAllTimersAsync();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("attachment", {
    id: "project_test",
    path: source.path,
    sha256: source.sha256,
    offset: 0,
  });
  expect(click).toHaveBeenCalledOnce();
  expect(status.textContent).toBe("Download started. Check your browser downloads.");
  expect(download.disabled).toBe(false);
});

it.each(["saved", "failed"])("waits for the file writer before reporting %s", async (outcome) => {
  const closed = Promise.withResolvers<void>();
  const writer = {
    write: vi.fn(async () => {}),
    close: vi.fn(() => closed.promise),
    abort: vi.fn(async () => {}),
  };
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async () => ({ createWritable: async () => writer })),
  });
  const { download, status } = control();
  download.click();
  await vi.waitFor(() => expect(writer.close).toHaveBeenCalledOnce());
  expect(status.textContent).toBe("4 / 4 bytes");
  expect(download.disabled).toBe(true);
  if (outcome === "saved") {
    closed.resolve();
  } else {
    closed.reject(new Error("Disk full"));
  }
  await vi.waitFor(() => expect(download.disabled).toBe(false));
  expect(status.textContent).toBe(
    outcome === "saved" ? "Original file downloaded." : "Error: Disk full",
  );
  expect(writer.abort).toHaveBeenCalledTimes(outcome === "saved" ? 0 : 1);
});

it("does not fetch or report success after the save picker is canceled", async () => {
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async () => {
      throw new DOMException("Canceled", "AbortError");
    }),
  });
  const { download, status, invoke } = control();
  download.click();
  await vi.waitFor(() => expect(download.disabled).toBe(false));
  expect(invoke).not.toHaveBeenCalled();
  expect(status.textContent).toContain("Canceled");
});
