import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeClaudeAgentSdk } from "./agent-sdk.runtime.js";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

const SESSION_ID = "a174e16f-b6e9-48da-ad5a-c437dfc2f9b4";
const SUCCESS_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  session_id: SESSION_ID,
};

function createContext(
  overrides: Partial<CliBackendExecuteContext> = {},
): CliBackendExecuteContext {
  return {
    command: "/usr/local/bin/claude",
    args: ["-p", "--output-format", "stream-json"],
    cwd: "/tmp/openclaw-workspace",
    env: { PATH: "/usr/local/bin:/usr/bin" },
    prompt: "Remember the launch code.",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "Follow the OpenClaw execution policy.",
    useResume: false,
    timeoutMs: 30_000,
    executionMode: "agent",
    requestToolPermission: vi.fn(async () => ({
      behavior: "deny" as const,
      message: "OpenClaw denied this action.",
    })),
    requestUserInput: vi.fn(async () => ({
      status: "cancelled" as const,
      message: "OpenClaw cancelled this question.",
    })),
    ...overrides,
  };
}

async function collect(context: CliBackendExecuteContext): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeAgentSdk(context)) {
    records.push(record);
  }
  return records;
}

afterEach(() => {
  queryMock.mockReset();
  vi.restoreAllMocks();
});

describe("Anthropic Agent SDK provider acceptance", () => {
  it("accepts a one-shot prompt only after the SDK advances past its transport write", async () => {
    const onProviderAccepted = vi.fn();
    let releaseWrite: (() => void) | undefined;
    const writeCompleted = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let receivedPrompt: Record<string, unknown> | undefined;
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) =>
      Object.assign(
        (async function* () {
          const iterator = prompt[Symbol.asyncIterator]();
          receivedPrompt = (await iterator.next()).value;
          await writeCompleted;
          await iterator.next();
          yield SUCCESS_RESULT;
        })(),
        { close: vi.fn() },
      ),
    );

    const running = collect(createContext({ onProviderAccepted }));
    await vi.waitFor(() => expect(receivedPrompt).toBeDefined());
    expect(onProviderAccepted).not.toHaveBeenCalled();
    releaseWrite?.();

    await expect(running).resolves.toContainEqual(SUCCESS_RESULT);
    expect(onProviderAccepted).toHaveBeenCalledOnce();
  });

  it("does not accept an Agent SDK prompt whose transport write rejects", async () => {
    const onProviderAccepted = vi.fn();
    const writeFailure = new Error("SDK transport write rejected");
    let releaseFailure: (() => void) | undefined;
    const failWrite = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let receivedPrompt: Record<string, unknown> | undefined;
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) =>
      Object.assign(
        (async function* () {
          yield* [];
          const iterator = prompt[Symbol.asyncIterator]();
          receivedPrompt = (await iterator.next()).value;
          await failWrite;
          await iterator.throw?.(writeFailure).catch(() => undefined);
          throw writeFailure;
        })(),
        { close: vi.fn() },
      ),
    );

    const running = collect(createContext({ onProviderAccepted }));
    await vi.waitFor(() => expect(receivedPrompt).toBeDefined());
    const rejected = expect(running).rejects.toThrow(writeFailure);
    releaseFailure?.();
    await rejected;
    expect(onProviderAccepted).not.toHaveBeenCalled();
  });

  it("fails closed when the official SDK exits without a terminal result", async () => {
    queryMock.mockReturnValue(
      Object.assign(
        (async function* () {
          yield* [];
        })(),
        { close: vi.fn() },
      ),
    );

    await expect(collect(createContext())).rejects.toThrow(
      "Claude Agent SDK exited without a terminal result.",
    );
  });

  it("preserves cache, effort, and checkpoint-fork controls through SDK options", async () => {
    let sdkOptions: Record<string, unknown> | undefined;
    queryMock.mockImplementation(
      ({
        prompt,
        options,
      }: {
        prompt: AsyncIterable<Record<string, unknown>>;
        options: Record<string, unknown>;
      }) =>
        Object.assign(
          (async function* () {
            for await (const message of prompt) {
              void message;
              sdkOptions = options;
            }
            yield SUCCESS_RESULT;
          })(),
          { close: vi.fn() },
        ),
    );

    await collect(
      createContext({
        args: [
          "-p",
          "--cache-system-prompt",
          "--effort",
          "max",
          "--fork-session",
          "--resume-session-at",
          "assistant-before-stall",
        ],
        sessionId: SESSION_ID,
        useResume: true,
      }),
    );

    expect(sdkOptions).toEqual(
      expect.objectContaining({
        resume: SESSION_ID,
        effort: "max",
        forkSession: true,
        resumeSessionAt: "assistant-before-stall",
        extraArgs: { "cache-system-prompt": null },
      }),
    );
  });
});
