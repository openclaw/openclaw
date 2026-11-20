import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { getResourceProfile } from "openclaw/plugin-sdk/resource-profile";
import { expect, it, vi } from "vitest";
import { ATTACHMENT_CHUNK_BYTES } from "./attachment-contract.js";
import { attachWorkspaceFile } from "./attachment-file.js";
import { RegistryClient } from "./registry-client.js";
import { StoreRuntime } from "./store-runtime.js";
import {
  afterTest,
  createVault,
  hostApi,
  plainAccess,
  toolContext,
  useTestTempDirs,
} from "./test-support.js";

vi.mock("openclaw/plugin-sdk/resource-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/resource-profile")>()),
  getResourceProfile: vi.fn(() => "standard"),
}));

const dirs = useTestTempDirs();
const workerOf = (client: object) => Reflect.get(client, "worker") as Worker | undefined;
function idleClock() {
  vi.mocked(getResourceProfile).mockReturnValue("lean");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  afterTest(() => {
    vi.useRealTimers();
    vi.mocked(getResourceProfile).mockReturnValue("standard");
  });
}

it("unwatched storage keeps a queued multi-RPC upload alive and reopens only after idle exit", async () => {
  const base = dirs.make("knowledge-idle-upload-"),
    { config, root } = await createVault(base),
    runtime = new StoreRuntime(config),
    access = plainAccess(),
    context = toolContext(hostApi(base).api),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  context.tool.workspaceDir = base;
  idleClock();
  afterTest(() => release.resolve());
  afterTest(() => runtime.retire());
  const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 1, 65),
    input = {
      requestId: randomUUID(),
      expectedVaultId: config.vaultId,
      filePath: "source.txt",
      filename: "source.txt",
      attribution: "Synthetic idle lifecycle fixture",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  await writeFile(path.join(base, input.filePath), bytes);
  let paused = false;
  const upload = () =>
    runtime.enqueue(access.assertCurrent, () =>
      attachWorkspaceFile(input, context, access.assertCurrent, async (chunk) => {
        const result = await runtime.client.call("attach", access, chunk);
        if (!paused) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      }),
    );
  const uploading = upload();
  await entered.promise;
  const worker = workerOf(runtime.client)!;
  const following = vi.fn();
  const queued = runtime.enqueue(access.assertCurrent, async () => {
    following();
    return runtime.client.call("catalog", access);
  });
  await vi.advanceTimersByTimeAsync(60_001);
  expect(workerOf(runtime.client), "RPC silence is not lane settlement").toBe(worker);
  expect(worker.threadId).toBeGreaterThan(0);
  expect(following).not.toHaveBeenCalled();
  release.resolve();
  const receipt = await uploading;
  await queued;
  expect(receipt.state).toBe("complete");
  expect(receipt.evidence?.sha256).toBe(input.sha256);
  expect(await readFile(path.join(root, "private", receipt.evidence!.path))).toEqual(bytes);
  expect(following).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(59_999);
  expect(workerOf(runtime.client)).toBe(worker);
  await runtime.enqueue(access.assertCurrent, () => runtime.client.call("catalog", access));
  await vi.advanceTimersByTimeAsync(59_999);
  expect(workerOf(runtime.client), "new work resets the deadline").toBe(worker);
  await vi.advanceTimersByTimeAsync(1);
  // A demand arriving during termination waits in the same physical-store lane.
  expect(await upload()).toEqual(receipt);
  expect(worker.threadId).toBe(-1);
  const replacement = workerOf(runtime.client)!;
  expect(replacement).not.toBe(worker);
  expect(replacement.threadId).toBeGreaterThan(0);
});

it("registry retirement preserves facts, excludes pending RPCs and joins exit before demand restart", async () => {
  const base = dirs.make("knowledge-idle-registry-"),
    registry = new RegistryClient(() => base),
    exited = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  idleClock();
  afterTest(() => release.resolve());
  afterTest(() => registry.dispose());
  const snapshot = await registry.load(),
    worker = workerOf(registry)!;
  await vi.advanceTimersByTimeAsync(59_999);
  expect(workerOf(registry)).toBe(worker);
  const pending = registry.call("maintenance", { nextRunAt: 123 });
  // Synchronous advancement cannot deliver the real worker's pending reply.
  vi.advanceTimersByTime(60_001);
  expect(workerOf(registry)).toBe(worker);
  await pending;
  const terminate = worker.terminate.bind(worker);
  const closing = vi.spyOn(worker, "terminate").mockImplementation(async () => {
    const code = await terminate();
    exited.resolve();
    await release.promise;
    return code;
  });
  afterTest(() => closing.mockRestore());
  await vi.advanceTimersByTimeAsync(60_000);
  await exited.promise;
  expect(registry.current).toBe(snapshot);
  const next = registry.call("maintenance"),
    concurrent = registry.load();
  expect(workerOf(registry), "no replacement before termination settles").toBeUndefined();
  release.resolve();
  expect(await next).toEqual({ nextRunAt: 123 });
  expect(await concurrent).toEqual(snapshot);
  expect(worker.threadId).toBe(-1);
  expect(workerOf(registry)).not.toBe(worker);
  expect(closing).toHaveBeenCalledOnce();
});
