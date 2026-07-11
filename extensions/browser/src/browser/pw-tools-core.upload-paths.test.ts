// Browser tests cover pw tools core.upload paths plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreNavigationGuardMocks,
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

vi.mock("./paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths.js")>();
  return {
    ...actual,
    resolveStrictExistingUploadPaths: pathMocks.resolveStrictExistingUploadPaths,
  };
});

installPwToolsCoreTestHooks();
const { armFileUploadViaPlaywright } = await import("./pw-tools-core.downloads.js");

function createFileChooserPageMocks(initialUrl = "https://safe.example/upload") {
  let currentUrl = initialUrl;
  const element = vi.fn(async () => {
    throw new Error("manual upload event dispatch is forbidden");
  });
  const fileChooser = { setFiles: vi.fn(async () => {}), element };
  const press = vi.fn(async () => {});
  const waitForEvent = vi.fn(async () => fileChooser);
  const page = {
    waitForEvent,
    keyboard: { press },
    url: vi.fn(() => currentUrl),
  };
  setPwToolsCoreCurrentPage(page);
  return {
    fileChooser,
    page,
    press,
    setUrl: (url: string) => {
      currentUrl = url;
    },
  };
}

describe("armFileUploadViaPlaywright upload path validation", () => {
  beforeEach(() => {
    pathMocks.resolveStrictExistingUploadPaths.mockReset();
    pathMocks.resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: true,
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
    });
  });

  it("sets resolved files once and leaves browser events to Playwright", async () => {
    const { fileChooser } = createFileChooserPageMocks();

    await armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
    });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(fileChooser.setFiles).toHaveBeenCalledWith([
        "/home/user/.openclaw/media/inbound/report.pdf",
      ]);
    });
    expect(fileChooser.setFiles).toHaveBeenCalledTimes(1);
    expect(fileChooser.element).not.toHaveBeenCalled();
    expect(
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
    ).not.toHaveBeenCalled();
    expect(getPwToolsCoreSessionMocks().withPageNavigationRequestGuard).not.toHaveBeenCalled();
  });

  it("escapes the chooser when paths are outside managed upload roots", async () => {
    pathMocks.resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: false,
      error: "Invalid path: must stay within inbound media directory",
    });
    const { fileChooser, press } = createFileChooserPageMocks();

    await armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: ["/etc/passwd"],
    });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(press).toHaveBeenCalledWith("Escape");
    });
    expect(fileChooser.setFiles).not.toHaveBeenCalled();
  });

  it("rechecks the page URL when the detached chooser uses resolved paths", async () => {
    let resolvePaths!: (
      result: { ok: true; paths: string[] } | { ok: false; error: string },
    ) => void;
    pathMocks.resolveStrictExistingUploadPaths.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePaths = resolve;
      }),
    );
    const { fileChooser, setUrl } = createFileChooserPageMocks();
    const blocked = new Error("SSRF blocked: private upload destination");
    blocked.name = "SsrFBlockedError";
    getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      blocked,
    );

    await armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
      ssrfPolicy: { allowPrivateNetwork: false },
    });
    await vi.waitFor(() => {
      expect(pathMocks.resolveStrictExistingUploadPaths).toHaveBeenCalledOnce();
    });

    setUrl("http://169.254.169.254/latest/meta-data/");
    resolvePaths({
      ok: true,
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
    });

    await vi.waitFor(() => {
      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledWith({
        ssrfPolicy: { allowPrivateNetwork: false },
        url: "http://169.254.169.254/latest/meta-data/",
      });
    });
    expect(fileChooser.setFiles).not.toHaveBeenCalled();
    expect(getPwToolsCoreSessionMocks().withPageNavigationRequestGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.any(Function),
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    );
  });

  it("passes the resolved policy to the chooser guard and blocks setFiles on denial", async () => {
    const { fileChooser, page } = createFileChooserPageMocks();
    const blocked = new Error("SSRF blocked during chooser upload");
    blocked.name = "SsrFBlockedError";
    getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockRejectedValueOnce(blocked);

    await armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    await vi.waitFor(() => {
      expect(getPwToolsCoreSessionMocks().withPageNavigationRequestGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.any(Function),
          page,
          ssrfPolicy: { allowPrivateNetwork: false },
        }),
      );
    });
    expect(fileChooser.setFiles).not.toHaveBeenCalled();
  });

  it("runs safe chooser setFiles inside the guard for the full grace window", async () => {
    vi.useFakeTimers();
    try {
      let guardActive = false;
      let setFilesSawGuard = false;
      getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockImplementationOnce(
        async ({ action }: { action: () => Promise<unknown> }) => {
          guardActive = true;
          try {
            return await action();
          } finally {
            guardActive = false;
          }
        },
      );
      const { fileChooser, page } = createFileChooserPageMocks();
      fileChooser.setFiles.mockImplementationOnce(async () => {
        setFilesSawGuard = guardActive;
      });

      await armFileUploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        paths: ["/home/user/.openclaw/media/inbound/report.pdf"],
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(fileChooser.setFiles).toHaveBeenCalledWith([
        "/home/user/.openclaw/media/inbound/report.pdf",
      ]);
      expect(setFilesSawGuard).toBe(true);
      expect(guardActive).toBe(true);
      expect(getPwToolsCoreSessionMocks().withPageNavigationRequestGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.any(Function),
          page,
          ssrfPolicy: { allowPrivateNetwork: false },
        }),
      );

      await vi.advanceTimersByTimeAsync(249);
      expect(guardActive).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(guardActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks arm ownership after the async URL policy check", async () => {
    vi.useFakeTimers();
    try {
      let resolvePolicy!: () => void;
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolvePolicy = resolve;
        }),
      );
      const { fileChooser, press } = createFileChooserPageMocks();

      await armFileUploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        paths: ["/home/user/.openclaw/media/inbound/first.pdf"],
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledOnce();

      await armFileUploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        paths: [],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(press).toHaveBeenCalledWith("Escape");

      resolvePolicy();
      await vi.advanceTimersByTimeAsync(0);
      expect(getPwToolsCoreSessionMocks().withPageNavigationRequestGuard).toHaveBeenCalledOnce();
      expect(fileChooser.setFiles).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      expect(fileChooser.setFiles).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not use a superseded chooser after async path resolution", async () => {
    let resolveFirst!: (result: { ok: true; paths: string[] }) => void;
    let firstResultRead = false;
    pathMocks.resolveStrictExistingUploadPaths
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        paths: ["/home/user/.openclaw/media/inbound/second.pdf"],
      });

    const firstChooser = { setFiles: vi.fn(async () => {}) };
    const secondChooser = { setFiles: vi.fn(async () => {}) };
    const waitForEvent = vi
      .fn()
      .mockResolvedValueOnce(firstChooser)
      .mockResolvedValueOnce(secondChooser);
    setPwToolsCoreCurrentPage({
      waitForEvent,
      keyboard: { press: vi.fn(async () => {}) },
    });

    await armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: ["/home/user/.openclaw/media/inbound/first.pdf"],
    });
    await vi.waitFor(() => {
      expect(pathMocks.resolveStrictExistingUploadPaths).toHaveBeenCalledOnce();
    });

    await armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: ["/home/user/.openclaw/media/inbound/second.pdf"],
    });
    await vi.waitFor(() => {
      expect(secondChooser.setFiles).toHaveBeenCalledWith([
        "/home/user/.openclaw/media/inbound/second.pdf",
      ]);
    });

    resolveFirst({
      get ok() {
        firstResultRead = true;
        return true as const;
      },
      paths: ["/home/user/.openclaw/media/inbound/first.pdf"],
    });
    await vi.waitFor(() => {
      expect(firstResultRead).toBe(true);
    });
    expect(firstChooser.setFiles).not.toHaveBeenCalled();
  });
});
