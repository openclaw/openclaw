import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
// Browser tests cover pw tools core.snapshot.navigate guard plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import * as pwSessionConnection from "./pw-session-connection.js";
import {
  getPwToolsCoreNavigationGuardMocks,
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreDownloadCapture,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.snapshot.js");

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "tab-1" };

function prepareReconnect() {
  const owner: { targetId?: string } = { targetId: "original-target" };
  const originalPage = {
    goto: vi.fn(async () => {
      owner.targetId = undefined;
      throw new Error("page.goto: Frame has been detached");
    }),
    url: vi.fn(() => "https://example.com/original"),
    on: vi.fn(),
    off: vi.fn(),
  };
  const replacementPage = {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.com/recovered"),
    on: vi.fn(),
    off: vi.fn(),
  };
  setPwToolsCoreCurrentPage(originalPage);
  const reconnect = vi.spyOn(pwSessionConnection, "connectBrowser").mockImplementation(async () => {
    owner.targetId = "replacement-target";
    return {} as Awaited<ReturnType<typeof pwSessionConnection.connectBrowser>>;
  });
  return { owner, originalPage, replacementPage, reconnect };
}

describe("pw-tools-core.snapshot navigate guard", () => {
  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks unsupported non-network URLs before page lookup", async () => {
    const goto = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "about:blank"),
    });

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "file:///etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(getPwToolsCoreSessionMocks().getPageForTargetId).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it("returns managed download metadata when navigation starts an attachment download", async () => {
    const download = {
      url: "https://example.com/export.csv",
      suggestedFilename: "export.csv",
      path: "/tmp/openclaw/downloads/export.csv",
    };
    const downloadCapture = {
      armed: true,
      promise: Promise.resolve(download),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    const page = {
      goto: vi.fn(async () => {
        throw new Error("page.goto: Download is starting");
      }),
      url: vi.fn(() => "https://example.com/start"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await mod.navigateViaPlaywright({
      ...target,
      url: "https://example.com/export.csv",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result).toEqual({ url: download.url, download });
    expect(downloadCapture.cancel).not.toHaveBeenCalled();
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).not.toHaveBeenCalled();
    expect(
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
    ).toHaveBeenCalledWith({
      url: download.url,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
  });

  it("handles capture timeouts that win before ordinary navigation settles", async () => {
    let rejectCapture!: (err: Error) => void;
    const downloadCapture = {
      armed: true,
      promise: new Promise<never>((_, reject) => {
        rejectCapture = reject;
      }),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage({
      goto: vi.fn(async () => {
        rejectCapture(new Error("Timeout waiting for navigation download"));
        await Promise.resolve();
      }),
      url: vi.fn(() => "https://example.com/final"),
    });

    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com/final",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result).toEqual({ url: "https://example.com/final" });
    expect(downloadCapture.cancel).toHaveBeenCalledTimes(1);
  });

  it("closes the tab when captured navigation download resolves to a blocked URL", async () => {
    const download = {
      url: "http://127.0.0.1:18080/export.csv",
      suggestedFilename: "export.csv",
      path: "/tmp/openclaw/downloads/export.csv",
    };
    const downloadCapture = {
      armed: true,
      promise: Promise.resolve(download),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    const page = {
      goto: vi.fn(async () => {
        throw new Error("page.goto: Download is starting");
      }),
      url: vi.fn(() => "https://93.184.216.34/start"),
    };
    setPwToolsCoreCurrentPage(page);
    getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      new SsrFBlockedError("Blocked hostname or private/internal/special-use IP address"),
    );

    await expect(
      mod.navigateViaPlaywright({
        ...target,
        url: "https://93.184.216.34/export.csv",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(getPwToolsCoreSessionMocks().closeBlockedNavigationTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      targetId: "tab-1",
    });
  });

  it("surfaces managed download save failures", async () => {
    const downloadCapture = {
      armed: true,
      promise: Promise.reject(new Error("download save failed")),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage({
      goto: vi.fn(async () => {
        throw new Error("page.goto: Download is starting");
      }),
      url: vi.fn(() => "https://example.com/start"),
    });

    await expect(
      mod.navigateViaPlaywright({
        ...target,
        url: "https://example.com/export.csv",
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toThrow("download save failed");
  });

  it("rethrows download-starting navigation errors when no download is captured", async () => {
    const downloadCapture = {
      armed: false,
      promise: new Promise<never>(() => {}),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage({
      goto: vi.fn(async () => {
        throw new Error("page.goto: Download is starting");
      }),
      url: vi.fn(() => "https://example.com/start"),
    });

    await expect(
      mod.navigateViaPlaywright({
        ...target,
        url: "https://example.com/export.csv",
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toThrow("Download is starting");

    expect(downloadCapture.cancel).toHaveBeenCalledTimes(1);
  });

  it("reconnects and retries once when navigation detaches frame", async () => {
    const goto = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("page.goto: Frame has been detached"))
      .mockResolvedValueOnce(undefined);
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://example.com/recovered"),
    });

    const result = await mod.navigateViaPlaywright({
      ...target,
      url: "https://example.com/recovered",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(getPwToolsCoreSessionMocks().getPageForTargetId).toHaveBeenCalledTimes(2);
    expect(getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget).toHaveBeenCalledTimes(
      1,
    );
    expect(getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      ...target,
      ssrfPolicy: { allowPrivateNetwork: true },
      page: expect.objectContaining({ goto }),
    });
    expect(getPwToolsCoreSessionMocks().gotoPageWithNavigationGuard).toHaveBeenCalledTimes(2);
    expect(result.url).toBe("https://example.com/recovered");
  });

  it("rebinds a detached navigation to the same relay-owned tab after reconnect", async () => {
    const { owner, originalPage, replacementPage, reconnect } = prepareReconnect();
    const session = getPwToolsCoreSessionMocks();
    session.getPageForTargetId
      .mockResolvedValueOnce(originalPage)
      .mockImplementationOnce(async () => {
        const selected = (
          session.getPageForTargetId.mock.calls.at(-1) as unknown[] | undefined
        )?.[0] as { targetId?: string } | undefined;
        if (selected?.targetId !== "replacement-target") {
          throw new BrowserTabNotFoundError({ input: selected?.targetId });
        }
        return replacementPage;
      });

    try {
      const navigation = {
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "original-target",
        url: "https://example.com/recovered",
        resolveOperationTarget: () => owner.targetId,
      };
      const result = await mod.navigateViaPlaywright(navigation);

      expect(reconnect).toHaveBeenCalledWith("http://127.0.0.1:18792", undefined, undefined);
      expect(session.getPageForTargetId).toHaveBeenLastCalledWith(
        expect.objectContaining({ targetId: "replacement-target" }),
      );
      expect(replacementPage.goto).toHaveBeenCalledTimes(1);
      expect(session.gotoPageWithNavigationGuard).toHaveBeenLastCalledWith(
        expect.objectContaining({
          targetId: "replacement-target",
          assertPageCurrent: expect.any(Function),
        }),
      );
      expect(session.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "replacement-target" }),
      );
      expect(result.url).toBe("https://example.com/recovered");
    } finally {
      reconnect.mockRestore();
    }
  });

  it.each([
    { reason: "owner is revoked before selection", revokeDuringLookup: false },
    { reason: "owner changes during the exact page lookup", revokeDuringLookup: true },
  ])("rejects detached navigation when its $reason", async ({ revokeDuringLookup }) => {
    const { owner, originalPage, replacementPage, reconnect } = prepareReconnect();
    reconnect.mockImplementation(async () => {
      owner.targetId = revokeDuringLookup ? "replacement-target" : undefined;
      return {} as Awaited<ReturnType<typeof pwSessionConnection.connectBrowser>>;
    });
    const session = getPwToolsCoreSessionMocks();
    session.getPageForTargetId.mockResolvedValueOnce(originalPage);
    if (revokeDuringLookup) {
      session.getPageForTargetId.mockImplementationOnce(async () => {
        owner.targetId = "unrelated-target";
        return replacementPage;
      });
    }

    try {
      await expect(
        mod.navigateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "original-target",
          url: "https://example.com/recovered",
          resolveOperationTarget: () => owner.targetId,
        }),
      ).rejects.toBeInstanceOf(BrowserTabNotFoundError);

      expect(replacementPage.goto).not.toHaveBeenCalled();
      expect(session.getPageForTargetId).toHaveBeenCalledTimes(revokeDuringLookup ? 2 : 1);
    } finally {
      reconnect.mockRestore();
    }
  });

  it("closes the replacement relay target when its retried navigation violates policy", async () => {
    const { owner, originalPage, replacementPage, reconnect } = prepareReconnect();
    const session = getPwToolsCoreSessionMocks();
    session.getPageForTargetId
      .mockResolvedValueOnce(originalPage)
      .mockResolvedValueOnce(replacementPage);
    session.assertPageNavigationCompletedSafely.mockRejectedValueOnce(
      new SsrFBlockedError("blocked replacement navigation"),
    );

    try {
      await expect(
        mod.navigateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "original-target",
          url: "https://example.com/recovered",
          resolveOperationTarget: () => owner.targetId,
        }),
      ).rejects.toBeInstanceOf(SsrFBlockedError);

      expect(session.closeBlockedNavigationTarget).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18792",
        page: replacementPage,
        targetId: "replacement-target",
      });
    } finally {
      reconnect.mockRestore();
    }
  });

  it("does not close the tab when post-navigation rejection is not a policy deny", async () => {
    // Non-policy errors (e.g. transient playwright failures) must not be
    // treated as "we navigated to a blocked URL" — the tab stays open.
    const goto = vi.fn(async () => ({ request: () => undefined }));
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://example.com/final"),
    });
    getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
      new Error("transient playwright error"),
    );

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://example.com/final",
      }),
    ).rejects.toThrow("transient playwright error");

    expect(getPwToolsCoreSessionMocks().closeBlockedNavigationTarget).not.toHaveBeenCalled();
  });
});
