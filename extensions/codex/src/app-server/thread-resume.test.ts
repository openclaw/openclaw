import { describe, expect, it, onTestFinished, vi } from "vitest";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import type { CodexThreadResumeParams } from "./protocol.js";
import { createClientHarness } from "./test-support.js";
import { CodexAdoptedThreadActiveError } from "./thread-lifecycle-errors.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";

function createClient(requestImpl: (method: string, params: unknown) => unknown) {
  const request = vi.fn(
    async (method: string, params: unknown) => await requestImpl(method, params),
  );
  const client = { request } as unknown as CodexAppServerClient;
  return { ...resumeFixture(client), request };
}

function resumeFixture(client: CodexAppServerClient) {
  const abandonClient = vi.fn(async () => undefined);
  const resume = (
    overrides: Partial<
      Omit<Parameters<typeof resumeCodexAppServerThread>[0], "client" | "abandonClient">
    > = {},
  ) =>
    resumeCodexAppServerThread({
      client,
      abandonClient,
      request: { threadId: "thread-1" },
      ...overrides,
    });
  return { client, abandonClient, resume };
}

function createHarness(options?: Parameters<typeof createClientHarness>[0]) {
  const harness = createClientHarness(options);
  onTestFinished(() => harness.client.close());
  return { ...harness, ...resumeFixture(harness.client) };
}

describe("resumeCodexAppServerThread", () => {
  it.each([
    { custom: false, written: false, prewrite: false },
    { custom: true, written: true, prewrite: false },
    { custom: false, written: false, prewrite: true },
  ])(
    "preserves subscription certainty (custom=$custom, written=$written, prewrite=$prewrite)",
    async ({ custom, written, prewrite }) => {
      const harness = createHarness();
      const { abandonClient } = harness;
      const rejection = new Error("host lineage changed");
      const reject = () => {
        throw rejection;
      };
      const withCurrent = async (write: () => void) => {
        if (written) {
          write();
        }
        reject();
      };
      await expect(
        harness.resume({
          withCurrent: prewrite ? undefined : withCurrent,
          assertCurrent: prewrite ? reject : undefined,
          ...(custom
            ? {
                requestResume: (request: CodexThreadResumeParams) =>
                  harness.client.request("thread/resume", request, { withCurrent }),
              }
            : {}),
        }),
      ).rejects.toMatchObject(
        written
          ? {
              name: "CodexAppServerUnsafeSubscriptionError",
              cause: {
                name: "CodexAppServerIndeterminateTransportError",
                mayHaveWritten: true,
                cause: rejection,
              },
            }
          : { name: "CodexAppServerScopedRequestRejectedError", cause: rejection },
      );
      expect(harness.writes).toHaveLength(written ? 1 : 0);
      expect(abandonClient).toHaveBeenCalledTimes(written ? 1 : 0);
      if (!written) {
        expect(harness.client.getCloseError()).toBeUndefined();
      }
    },
  );

  it("resumes the requested thread and keeps the client leased", async () => {
    const { client, request } = createClient(async () => threadStartResult("thread-1", "/repo"));
    const abandonClient = vi.fn(async () => undefined);

    const response = await resumeRequestedThread(client, {
      abandonClient,
      request: { threadId: "thread-1", excludeTurns: true },
    });

    expect(response.thread.id).toBe("thread-1");
    expect(request).toHaveBeenCalledWith("thread/resume", expect.anything(), expect.anything());
    expect(abandonClient).not.toHaveBeenCalled();
  });

  it.each<[string, number, string, string, boolean]>([
    ["thread/resume", -32_600, "thread-1", "", true],
    ["thread/read", -32_600, "thread-1", "", false],
    ["thread/resume", -32_600, "thread-2", "", false],
    ["thread/resume", -32_600, "thread-1", " extra", false],
  ])(
    "preserves only the exact closing rejection (%s/%s/%s/%s)",
    async (method, code, threadId, suffix, closing) => {
      const rejection = new CodexAppServerRpcError(
        {
          code,
          message: `thread ${threadId} is closing; retry thread/resume after the thread is closed${suffix}`,
        },
        method,
      );
      const { resume, abandonClient, request } = createClient((requestMethod) => {
        if (requestMethod === "thread/resume") {
          throw rejection;
        }
        return { status: "unsubscribed" };
      });
      await expect(resume()).rejects.toBe(rejection);
      expect(request.mock.calls.map(([requestMethod]) => requestMethod)).toEqual(
        closing ? ["thread/resume"] : ["thread/resume", "thread/unsubscribe"],
      );
      expect(abandonClient).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "settles a written resume failure with cleanup authority=%s",
    async (ownsCleanup) => {
      let current = true;
      const harness = createHarness({
        onWrite(line, send) {
          const request = JSON.parse(line);
          if (request.method === "thread/unsubscribe") {
            send({ id: request.id, result: { status: "unsubscribed" } });
          }
        },
      });
      const { abandonClient } = harness;
      abandonClient.mockImplementation(async () => harness.client.close());
      const request = vi.spyOn(harness.client, "request");
      const assertCurrent = () => {
        if (!current) {
          throw new CodexAdoptedThreadActiveError();
        }
      };
      const onSubscriptionReleased = vi.fn();
      const error = { code: -32_603, message: "resume response assembly failed" };
      const failure = expect(
        harness.resume({ assertCurrent, onSubscriptionReleased }),
      ).rejects.toMatchObject(
        ownsCleanup
          ? { name: "CodexAppServerRpcError", ...error }
          : { name: "CodexAppServerUnsafeSubscriptionError", cause: error },
      );
      const written = JSON.parse(await harness.waitForWrite(0));
      expect(written).toMatchObject({ method: "thread/resume", params: { threadId: "thread-1" } });
      current = ownsCleanup;
      harness.send({ id: written.id, error });
      await failure;
      expect(harness.writes.map((line) => JSON.parse(line).method)).toEqual(
        ownsCleanup ? ["thread/resume", "thread/unsubscribe"] : ["thread/resume"],
      );
      expect(onSubscriptionReleased).toHaveBeenCalledTimes(ownsCleanup ? 1 : 0);
      expect(abandonClient).toHaveBeenCalledTimes(ownsCleanup ? 0 : 1);
      if (ownsCleanup) {
        expect(request).toHaveBeenLastCalledWith(
          "thread/unsubscribe",
          { threadId: "thread-1" },
          { timeoutMs: 5_000, assertCurrent },
        );
      } else {
        expect(harness.client.getCloseError()).toBeDefined();
      }
    },
  );

  it("retires the exact client when the response names another thread", async () => {
    const { resume, abandonClient } = createClient(async () =>
      threadStartResult("thread-2", "/repo"),
    );

    await expect(resume({ request: { threadId: "thread-1", excludeTurns: true } })).rejects.toThrow(
      "returned thread-2 for thread-1",
    );
    expect(abandonClient).toHaveBeenCalledOnce();
  });
});
