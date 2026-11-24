import { PassThrough, type Writable } from "node:stream";
import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OwnedStdioProcess } from "../process/owned-stdio.js";

export function writeRpc(stdout: PassThrough, ...messages: unknown[]) {
  stdout.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
}

export function rejectStdioWrites(stdin: PassThrough, failure: Error, mode = "callback") {
  vi.spyOn(stdin, "write").mockImplementation(
    (
      _data,
      encodingOrCallback: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      if (mode === "throw") {
        throw failure;
      }
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      done?.(failure);
      return false;
    },
  );
}

export async function waitForStdioCleanup(child: OwnedStdioProcess) {
  await child.wait();
  await child.waitForExtinction?.();
}

export function createStdioProcessFixture() {
  const root = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const extinction = createDeferred();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let onError: Parameters<OwnedStdioProcess["onError"]>[0] | undefined;
  const capture =
    (stream: PassThrough) => (_decoded: (text: string) => void, raw?: (chunk: Buffer) => void) => {
      if (raw) {
        stream.on("data", raw);
      }
    };
  const child = {
    pid: 4321,
    stdin,
    supportsRawOutput: true,
    onStdout: capture(stdout),
    onStderr: capture(stderr),
    onExit: () => {},
    onError: (listener: NonNullable<typeof onError>) => {
      onError = listener;
    },
    wait: () => root.promise,
    waitForExtinction: () => extinction.promise,
    kill: vi.fn<(signal?: NodeJS.Signals) => void>(),
    dispose: vi.fn(),
  } satisfies OwnedStdioProcess;
  return {
    child,
    root,
    extinction,
    stdin,
    stdout,
    stderr,
    emitError: (error: Error) => onError?.(error, "stderr"),
    spawn: async ({ stderrDestination }: { stderrDestination?: Writable }) => {
      if (stderrDestination) {
        stderr.pipe(stderrDestination, { end: false });
      }
      return child;
    },
    cleanup: () => {
      root.resolve({ code: 0, signal: null });
      extinction.resolve();
      for (const stream of [stdin, stdout, stderr]) {
        stream.destroy();
      }
    },
  };
}
