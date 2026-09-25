import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { appendCapturedOutput, createCapturedOutputBuffers } from "../../process/exec-output.js";
import { SANDBOX_UPLOAD_DIAGNOSTIC_TAIL_BYTES } from "./constants.js";
import { createRemoteShellSandboxSession } from "./remote-shell-transport.js";

const spawnMock = vi.hoisted(() => vi.fn());

let localDir: string;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

/**
 * The upload pipeline pipes a tar archive between two raw children and drains
 * their diagnostics by hand, so it cannot use `maxBuffer`. These tests pin the
 * bound that keeps remote output from growing the Gateway heap.
 */
describe("remote shell upload diagnostic bound", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    localDir = mkdtempSync(join(tmpdir(), "openclaw-upload-bound-"));
    // A real file tree so the symlink guard has something valid to walk.
    writeFileSync(join(localDir, "seed.txt"), "seed\n", "utf8");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(localDir, { recursive: true, force: true });
  });

  it("bounds the retained diagnostic tail and reports what was dropped", () => {
    const capture = createCapturedOutputBuffers();
    const emittedBytes = 400 * 64 * 1024;

    for (let index = 0; index < 400; index += 1) {
      appendCapturedOutput(
        capture,
        Buffer.alloc(64 * 1024, 0x62),
        SANDBOX_UPLOAD_DIAGNOSTIC_TAIL_BYTES,
        "tail",
      );
    }

    // Retention is bounded by the constant, not by what the remote emitted.
    expect(capture.bytes).toBeLessThanOrEqual(SANDBOX_UPLOAD_DIAGNOSTIC_TAIL_BYTES);
    expect(capture.truncatedBytes).toBe(emittedBytes - SANDBOX_UPLOAD_DIAGNOSTIC_TAIL_BYTES);
  });

  it("discards mirrored remote stdout without retaining a copy of the archive", () => {
    const capture = createCapturedOutputBuffers();

    for (let index = 0; index < 400; index += 1) {
      appendCapturedOutput(capture, Buffer.alloc(64 * 1024, 0x61), 0, "discard");
    }

    // The archive is piped to the remote `tar -xf`; nothing reads this stream.
    expect(capture.bytes).toBe(0);
    expect(capture.chunks).toHaveLength(0);
    expect(capture.truncatedBytes).toBe(400 * 64 * 1024);
  });

  it("bounds the diagnostic a real transfer retains, and keeps the newest bytes", async () => {
    const tar = createFakeChildProcess();
    const remote = createFakeChildProcess();
    const children = [tar, remote];
    let spawnIndex = 0;
    // Only the spawn boundary is replaced; the collectors under test stay real.
    spawnMock.mockImplementation((() => children[spawnIndex++]!) as never);

    const emittedPerStream = 8 * SANDBOX_UPLOAD_DIAGNOSTIC_TAIL_BYTES;
    const marker = "NEWEST-REMOTE-DIAGNOSTIC";
    const session = createRemoteShellSandboxSession({
      buildCommand: () => ({ argv: [process.execPath, "-e", "0"], env: {} }),
    });

    const upload = session.uploadDirectory({
      localDir,
      remoteDir: "/remote/workspace",
    });

    // The uploader walks the local tree before spawning, so wait for the
    // children to be spawned and for the pipeline's listeners to attach.
    await withTestTimeout(
      waitForListeners(remote),
      10_000,
      "the uploader never attached the remote child's listeners",
    );
    await withTestTimeout(
      waitForListeners(tar),
      10_000,
      "the uploader never attached the tar child's listeners",
    );

    remote.stdout.write(Buffer.alloc(emittedPerStream, 0x61));
    const chunks = Math.ceil(emittedPerStream / (64 * 1024));
    for (let index = 0; index < chunks; index += 1) {
      const isLast = index === chunks - 1;
      remote.stderr.write(
        isLast
          ? Buffer.concat([Buffer.alloc(64 * 1024 - marker.length, 0x62), Buffer.from(marker)])
          : Buffer.alloc(64 * 1024, 0x62),
      );
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    tar.emit("close", 0, null);
    remote.emit("close", 1, null);

    const error = await upload.then(
      () => {
        throw new Error("expected the upload to reject on a nonzero remote exit");
      },
      (rejection: unknown) => rejection as Error,
    );

    // The newest remote complaint survives — that is what an operator needs.
    expect(error.message).toContain(marker);
    // A clipped diagnostic announces itself instead of reading as complete.
    expect(error.message).toContain("truncated");
    // The retained diagnostic is bounded by the constant, not by what was
    // emitted. The unpatched pipeline concatenated every chunk, so the reported
    // total stays proportional to the emitted volume — that is the regression.
    const reportedDropped = Number(/(\d+) earlier bytes/.exec(error.message)?.[1]);
    expect(reportedDropped).toBeGreaterThan(0);
    expect(reportedDropped).toBe(emittedPerStream - SANDBOX_UPLOAD_DIAGNOSTIC_TAIL_BYTES);
    expect(remote.kill).not.toHaveBeenCalled();
  });
});

type FakeChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

/** Resolve once `emitter` gains a listener for `event`, observed through its own `newListener`. */
function waitForAttachedListener(emitter: EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => {
    const onNewListener = (added: string | symbol) => {
      if (added !== event) {
        return;
      }
      emitter.off("newListener", onNewListener);
      resolve();
    };
    emitter.on("newListener", onNewListener);
  });
}

/**
 * Resolve once the uploader has wired its close/data listeners onto the child.
 *
 * The uploader signals readiness by attaching those listeners, so follow the emitters'
 * `newListener` events instead of polling on a timer: a regression that never attaches them
 * then leaves nothing rescheduling after `withTestTimeout` rejects.
 */
async function waitForListeners(child: FakeChildProcess): Promise<void> {
  const waits: Promise<void>[] = [];
  if (child.listenerCount("close") === 0) {
    waits.push(waitForAttachedListener(child, "close"));
  }
  if (child.stdout.listenerCount("data") === 0) {
    waits.push(waitForAttachedListener(child.stdout, "data"));
  }
  await Promise.all(waits);
}

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  // The remote's stdin receives the piped archive; drain it or the tar side
  // blocks on a full pipe instead of settling.
  child.stdin.resume();
  child.kill = vi.fn(() => true);
  return child;
}
