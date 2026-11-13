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
  return { client, request };
}

function resumeRequestedThread(
  client: CodexAppServerClient,
  overrides: Omit<Parameters<typeof resumeCodexAppServerThread>[0], "client" | "request"> & {
    request?: CodexThreadResumeParams;
  },
) {
  return resumeCodexAppServerThread({
    client,
    request: { threadId: "thread-1" },
    ...overrides,
  });
}

function createHarness(options?: Parameters<typeof createClientHarness>[0]) {
  const harness = createClientHarness(options);
  onTestFinished(() => harness.client.close());
  return harness;
}

describe("resumeCodexAppServerThread", () => {
  it.each([
    { custom: false, written: false },
    { custom: true, written: true },
  ])(
    "preserves subscription certainty (custom=$custom, written=$written)",
    async ({ custom, written }) => {
      const harness = createHarness();
      const abandonClient = vi.fn(async () => undefined);
      const rejection = new Error("host lineage changed");
      const withCurrent = async (write: () => void) => {
        if (written) {
          write();
        }
        throw rejection;
      };
      await expect(
        resumeRequestedThread(harness.client, {
          abandonClient,
          withCurrent,
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
    ["thread/resume", -32_603, "thread-1", "", false],
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
      const { client, request } = createClient((requestMethod) => {
        if (requestMethod === "thread/resume") {
          throw rejection;
        }
        return { status: "unsubscribed" };
      });
      const abandonClient = vi.fn(async () => undefined);
      await expect(resumeRequestedThread(client, { abandonClient })).rejects.toBe(rejection);
      expect(request.mock.calls.map(([requestMethod]) => requestMethod)).toEqual(
        closing ? ["thread/resume"] : ["thread/resume", "thread/unsubscribe"],
      );
      expect(abandonClient).not.toHaveBeenCalled();
    },
  );

  it("preserves a physical pre-write ownership rejection without cleanup or retirement", async () => {
    const rejection = new Error("host authority ended");
    const harness = createHarness();
    const abandonClient = vi.fn(async () => undefined);
    await expect(
      resumeRequestedThread(harness.client, {
        abandonClient,
        assertCurrent: () => {
          throw rejection;
        },
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerScopedRequestRejectedError",
      cause: rejection,
    });
    expect(harness.writes).toEqual([]);
    expect(harness.client.getCloseError()).toBeUndefined();
    expect(abandonClient).not.toHaveBeenCalled();
  });

  it("unsubscribes a physical resume whose native response assembly fails", async () => {
    const harness = createHarness({
      onWrite(line, send) {
        const request = JSON.parse(line);
        send(
          request.method === "thread/resume"
            ? {
                id: request.id,
                error: { code: -32_603, message: "resume response assembly failed" },
              }
            : { id: request.id, result: { status: "unsubscribed" } },
        );
      },
    });
    const request = vi.spyOn(harness.client, "request");
    const assertCurrent = vi.fn();
    const abandonClient = vi.fn(async () => undefined);
    const onSubscriptionReleased = vi.fn();
    await expect(
      resumeRequestedThread(harness.client, {
        abandonClient,
        onSubscriptionReleased,
        assertCurrent,
      }),
    ).rejects.toMatchObject({ name: "CodexAppServerRpcError", code: -32_603 });
    expect(harness.writes.map((line) => JSON.parse(line).method)).toEqual([
      "thread/resume",
      "thread/unsubscribe",
    ]);
    expect(onSubscriptionReleased).toHaveBeenCalledOnce();
    expect(abandonClient).not.toHaveBeenCalled();
    expect(request).toHaveBeenLastCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 5_000, assertCurrent },
    );
  });

  it("retires the exact client after a written structured failure loses cleanup ownership", async () => {
    const harness = createHarness();
    let current = true;
    const abandonClient = vi.fn(async () => harness.client.close());
    const resume = resumeRequestedThread(harness.client, {
      abandonClient,
      assertCurrent: () => {
        if (!current) {
          throw new CodexAdoptedThreadActiveError();
        }
      },
    });
    const failure = expect(resume).rejects.toMatchObject({
      name: "CodexAppServerUnsafeSubscriptionError",
      cause: { code: -32_603, message: "resume response assembly failed" },
    });
    const writtenText = harness.writes[0];
    expect(writtenText).toBeDefined();
    const written = JSON.parse(writtenText ?? "");
    expect(written).toMatchObject({ method: "thread/resume", params: { threadId: "thread-1" } });
    current = false;
    harness.send({
      id: written.id,
      error: { code: -32_603, message: "resume response assembly failed" },
    });
    await failure;
    expect(harness.writes).toHaveLength(1);
    expect(abandonClient).toHaveBeenCalledOnce();
    expect(harness.client.getCloseError()).toBeDefined();
  });

  it("retires the exact client when the response names another thread", async () => {
    const { client } = createClient(async () => threadStartResult("thread-2", "/repo"));
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      resumeRequestedThread(client, {
        abandonClient,
        request: { threadId: "thread-1", excludeTurns: true },
      }),
    ).rejects.toThrow("returned thread-2 for thread-1");
    expect(abandonClient).toHaveBeenCalledOnce();
  });
});
