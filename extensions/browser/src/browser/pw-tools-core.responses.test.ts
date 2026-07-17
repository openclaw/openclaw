import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

const sessionMocks = getPwToolsCoreSessionMocks();

let mod: typeof import("./pw-tools-core.responses.js");

describe("pw-tools-core response bodies", () => {
  installPwToolsCoreTestHooks();

  beforeAll(async () => {
    vi.doMock("./pw-session.js", () => sessionMocks);
    mod = await import("./pw-tools-core.responses.js");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function installResponsePage() {
    let responseHandler: ((resp: unknown) => void) | undefined;
    const on = vi.fn((event: string, handler: (resp: unknown) => void) => {
      if (event === "response") {
        responseHandler = handler;
      }
    });
    const off = vi.fn();
    setPwToolsCoreCurrentPage({ on, off });
    return {
      off,
      requireResponseHandler: () => {
        if (!responseHandler) {
          throw new Error("expected Playwright response handler");
        }
        return responseHandler;
      },
    };
  }

  it("rejects when a matched response body misses the same deadline", async () => {
    vi.useFakeTimers();
    const page = installResponsePage();

    const result = mod.responseBodyViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      url: "**/api/hangs",
      timeoutMs: 500,
    });

    await Promise.resolve();
    const responseHandler = page.requireResponseHandler();
    responseHandler({
      url: () => "https://example.com/api/hangs",
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      body: () => new Promise<Buffer>(() => {}),
    });

    const deadlineExpectation = expect(result).rejects.toThrow(
      /Failed to read response body.*Response body read timed out after 500ms/,
    );
    await vi.advanceTimersByTimeAsync(500);

    await deadlineExpectation;
    expect(page.off).toHaveBeenCalledWith("response", responseHandler);
  });

  it("still returns a normal matched response body", async () => {
    const page = installResponsePage();
    const result = mod.responseBodyViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      url: "**/api/ok",
      timeoutMs: 500,
    });

    await Promise.resolve();
    page.requireResponseHandler()({
      url: () => "https://example.com/api/ok",
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      body: async () => Buffer.from('{"ok":true}'),
    });

    await expect(result).resolves.toMatchObject({
      url: "https://example.com/api/ok",
      status: 200,
      body: '{"ok":true}',
    });
  });
});
