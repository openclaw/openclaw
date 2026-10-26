import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileChooserPage } from "./pw-tools-core.guard-test-support.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

const pathMocks = vi.hoisted(() => ({
  resolveStrictExistingUploadPaths:
    vi.fn<
      (args: {
        requestedPaths: string[];
      }) => Promise<{ ok: true; paths: string[] } | { ok: false; error: string }>
    >(),
}));

const interactionMocks = vi.hoisted(() => ({
  clickViaPlaywright: vi.fn<(opts: { signal?: AbortSignal }) => Promise<void>>(async () => {}),
}));

vi.mock("./paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths.js")>();
  return {
    ...actual,
    resolveStrictExistingUploadPaths: pathMocks.resolveStrictExistingUploadPaths,
  };
});

vi.mock("./pw-tools-core.interactions.actions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-tools-core.interactions.actions.js")>()),
  ...interactionMocks,
}));

installPwToolsCoreTestHooks();
const sessionMocks = getPwToolsCoreSessionMocks();
const { armFileUploadViaPlaywright, uploadViaPlaywright } =
  await import("./pw-tools-core.downloads.js");

function nativeAbortError(signal: AbortSignal) {
  return Object.assign(new Error("Operation aborted", { cause: signal.reason }), {
    name: "AbortError",
  });
}

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
const uploadPaths = ["/home/user/.openclaw/media/inbound/report.pdf"];
const startUpload = (
  ref: string,
  options: Partial<Parameters<typeof uploadViaPlaywright>[0]> = {},
) => uploadViaPlaywright({ cdpUrl: target.cdpUrl, ref, paths: uploadPaths, ...options });
let page: ReturnType<typeof fileChooserPage>;

describe("armFileUploadViaPlaywright upload path validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page = fileChooserPage();
    setPwToolsCoreCurrentPage(page.currentPage);
    interactionMocks.clickViaPlaywright.mockReset().mockResolvedValue(undefined);
    pathMocks.resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: true,
      paths: uploadPaths,
    });
  });

  it.each(["page", "payload"] as const)("checks authority after %s preparation", async (stage) => {
    interactionMocks.clickViaPlaywright.mockImplementationOnce(async () => page.emitChooser());
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const wait = async () => {
      entered.resolve();
      await release.promise;
    };
    if (stage === "page") {
      sessionMocks.getPageForTargetId.mockImplementationOnce(async () => {
        await wait();
        return page.currentPage;
      });
    } else {
      pathMocks.resolveStrictExistingUploadPaths.mockImplementationOnce(
        async ({ requestedPaths }) => {
          await wait();
          return { ok: true, paths: requestedPaths };
        },
      );
    }
    let current = true;
    const operation = startUpload("e1", {
      ...target,
      paths: ["/tmp/upload.txt"],
      assertCurrent: async () => {
        if (!current) {
          throw new Error("Dashboard upload revoked");
        }
      },
    });
    const settled = Promise.allSettled([operation]);
    try {
      await Promise.race([
        entered.promise,
        operation.then(() => {
          throw new Error("Upload skipped held preparation");
        }),
      ]);
      current = false;
      release.resolve();
      expect(await settled).toMatchObject([
        { status: "rejected", reason: { message: "Dashboard upload revoked" } },
      ]);
      expect(page.fileChooser.setFiles).not.toHaveBeenCalled();
      expect(page.listenerCount()).toBe(0);
      if (stage === "page") {
        expect(interactionMocks.clickViaPlaywright).not.toHaveBeenCalled();
      } else {
        expect(page.press).toHaveBeenCalledExactlyOnceWith("Escape");
      }
    } finally {
      release.resolve();
      page.emitChooser();
      await settled;
    }
  });

  it("keeps an accepted passive upload arm alive after its requesting invocation ends", async () => {
    const invocation = new AbortController();
    const assertCurrent = vi.fn(async () => invocation.signal.throwIfAborted());
    try {
      await armFileUploadViaPlaywright({
        ...target,
        paths: ["/tmp/upload.txt"],
        assertCurrent,
      });
      invocation.abort(new Error("requesting invocation ended"));
      page.emitChooser();
      await vi.waitFor(() => expect(page.fileChooser.setFiles).toHaveBeenCalledOnce());
      expect(page.listenerCount()).toBe(0);
    } finally {
      page.emitChooser();
    }
  });

  it("propagates strict path revalidation failures", async () => {
    pathMocks.resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: false,
      error: "Invalid path: upload target changed",
    });
    interactionMocks.clickViaPlaywright.mockImplementation(async () => page.emitChooser());

    await expect(startUpload("e12")).rejects.toThrow("Invalid path: upload target changed");
    expect(page.press).not.toHaveBeenCalled();
    expect(page.fileChooser.setFiles).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(0);
  });

  it("bounds file assignment by the same request deadline", async () => {
    vi.useFakeTimers();
    try {
      interactionMocks.clickViaPlaywright.mockImplementation(async () => page.emitChooser());
      page.fileChooser.setFiles.mockImplementation(
        async (_paths, options) =>
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(nativeAbortError(options.signal)),
              { once: true },
            );
          }),
      );
      const upload = startUpload("e12", { timeoutMs: 500 });
      const rejection = expect(upload).rejects.toThrow(
        "Timeout 500ms exceeded while completing file upload",
      );

      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(page.press).not.toHaveBeenCalled();
      expect(page.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the cleanup tail when a queued owner aborts", async () => {
    let firstSignal: AbortSignal | undefined;
    let finishCancellation!: () => void;
    page.fileChooser.setFiles
      .mockImplementationOnce(
        async (_paths, options) =>
          await new Promise<void>((_resolve, reject) => {
            firstSignal = options.signal;
            finishCancellation = () => reject(nativeAbortError(options.signal));
          }),
      )
      .mockResolvedValueOnce(undefined);
    interactionMocks.clickViaPlaywright
      .mockImplementationOnce(async () => page.emitChooser())
      .mockImplementationOnce(async () => page.emitChooser());

    const first = startUpload("e1", { paths: ["/home/user/.openclaw/media/inbound/first.pdf"] });
    const firstRejection = expect(first).rejects.toThrow("superseded by another waiter");
    await vi.waitFor(() => expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(1));

    const secondController = new AbortController();
    const second = startUpload("e2", {
      paths: ["/home/user/.openclaw/media/inbound/second.pdf"],
      signal: secondController.signal,
    });
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
    secondController.abort(new Error("queued upload aborted"));
    await expect(second).rejects.toThrow("queued upload aborted");

    const third = startUpload("e3", { paths: ["/home/user/.openclaw/media/inbound/third.pdf"] });
    await Promise.resolve();
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1);

    finishCancellation();
    await firstRejection;
    await third;
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(2);
    expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(2);
    expect(page.listenerCount()).toBe(0);
  });

  it("waits for a superseded click to settle before arming the next chooser", async () => {
    let finishFirstClick!: () => void;
    interactionMocks.clickViaPlaywright
      .mockImplementationOnce(
        async () =>
          await new Promise<void>((resolve) => {
            finishFirstClick = () => {
              page.emitChooser();
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async () => page.emitChooser());

    const first = startUpload("e1", { paths: ["/home/user/.openclaw/media/inbound/first.pdf"] });
    await vi.waitFor(() => expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1));
    const second = startUpload("e2", { paths: ["/home/user/.openclaw/media/inbound/second.pdf"] });
    await Promise.resolve();
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1);

    finishFirstClick();
    await expect(first).rejects.toThrow("superseded by another waiter");
    await second;
    expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(1);
    expect(page.press).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(0);
  });
});
