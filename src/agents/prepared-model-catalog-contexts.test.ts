import { expect, it, vi } from "vitest";
import {
  PluginRuntimeCloseCompletedError,
  PluginRuntimeCloseRetainedError,
} from "../plugins/runtime-close-error.js";
import {
  decodePreparedCatalogRetirement,
  encodePreparedCatalogRetirement,
  preparedCatalogOwnerKey,
  PreparedCatalogContexts,
} from "./prepared-model-catalog-contexts.js";

const first = preparedCatalogOwnerKey("first", "/agents/shared");
const second = preparedCatalogOwnerKey("second", "/agents/shared");
const elsewhere = preparedCatalogOwnerKey("first", "/agents/elsewhere");
const identity = (workspaceDir = "workspace", fingerprint = "initial") => ({
  workspaceDir,
  fingerprint,
  registrationFingerprint: fingerprint,
});
const generation = () => ({ release: vi.fn<() => Promise<void>>(async () => {}) });
type TestGeneration = ReturnType<typeof generation>;

async function seed(
  contexts: PreparedCatalogContexts<TestGeneration>,
  owner: string | undefined,
  workspace = "workspace",
) {
  const admitted = contexts.begin(identity(workspace), owner);
  const prepared = generation();
  contexts.publish(admitted, prepared);
  await contexts.finish(admitted);
  return prepared;
}

it("releases only the deleted exact identity's last workspace", async () => {
  const contexts = new PreparedCatalogContexts<TestGeneration>();
  const deleted = await seed(contexts, first);
  const survivor = await seed(contexts, elsewhere, "elsewhere");
  await contexts.retire([first]);
  expect([...contexts.values()].map((context) => context.workspaceDir)).toEqual(["elsewhere"]);
  expect(deleted.release).toHaveBeenCalledOnce();
  expect(survivor.release).not.toHaveBeenCalled();
});

it.each([second, undefined])("preserves a shared or unknown owner (%s)", async (owner) => {
  const contexts = new PreparedCatalogContexts<TestGeneration>();
  const prepared = await seed(contexts, first);
  await contexts.finish(contexts.begin(identity(), owner));
  await contexts.retire([first]);
  expect(contexts.get("workspace")?.prepared).toBe(prepared);
  expect(prepared.release).not.toHaveBeenCalled();
  if (owner) {
    await contexts.retire([owner]);
    expect(prepared.release).toHaveBeenCalledOnce();
  }
});

it("detaches immediately but joins the active generation's current release", async () => {
  const contexts = new PreparedCatalogContexts<TestGeneration>();
  const prepared = await seed(contexts, first);
  const admitted = contexts.begin(identity(), first);
  const released = Promise.withResolvers<void>();
  const originalRelease = prepared.release;
  const receipt = vi.fn();
  const retirement = contexts.retire([first]).then(receipt);
  expect(contexts.get("workspace")).toBeUndefined();
  expect(originalRelease).not.toHaveBeenCalled();
  // Discovery can expand the same generation before its admitted work drains.
  prepared.release = vi.fn(() => released.promise);
  const finishing = contexts.finish(admitted);
  await Promise.resolve();
  expect(prepared.release).toHaveBeenCalledOnce();
  expect(originalRelease).not.toHaveBeenCalled();
  expect(receipt).not.toHaveBeenCalled();
  released.resolve();
  await Promise.all([finishing, retirement]);
  expect(receipt).toHaveBeenCalledOnce();
});

it.each(["initial", "replacement", "shared"])(
  "fences deleted active %s preparation without later publication",
  async (mode) => {
    const contexts = new PreparedCatalogContexts<TestGeneration>();
    const previous = mode === "initial" ? undefined : await seed(contexts, first);
    if (mode === "shared") {
      await contexts.finish(contexts.begin(identity(), second));
    }
    const admitted = contexts.begin(identity("workspace", "replacement"), first);
    const retirement = contexts.retire([first]);
    expect(() => contexts.assertCurrent(admitted)).toThrow("owner retired");
    expect(() => contexts.publish(admitted, generation())).toThrow("owner retired");
    await contexts.finish(admitted);
    await retirement;
    expect(contexts.get("workspace")?.prepared).toBe(mode === "shared" ? previous : undefined);
    if (previous) {
      expect(previous.release).toHaveBeenCalledTimes(mode === "shared" ? 0 : 1);
    }
  },
);

it("does not join an unrelated active workspace", async () => {
  const contexts = new PreparedCatalogContexts<TestGeneration>();
  const deleted = await seed(contexts, first);
  await seed(contexts, second, "survivor");
  const admitted = contexts.begin(identity("survivor"), second);
  await contexts.retire([first]);
  expect(deleted.release).toHaveBeenCalledOnce();
  expect(() => contexts.assertCurrent(admitted)).not.toThrow();
  await contexts.finish(admitted);
});

it("joins every detached replacement and exposes cleanup failure to the retirement receipt", async () => {
  const contexts = new PreparedCatalogContexts<TestGeneration>();
  const previous = await seed(contexts, first);
  const admitted = contexts.begin(identity("workspace", "replacement"), first);
  const next = generation();
  contexts.publish(admitted, next);
  const failure = new PluginRuntimeCloseRetainedError(new Error("release failed"));
  previous.release.mockRejectedValue(failure);
  const releaseNext = Promise.withResolvers<void>();
  next.release.mockImplementation(() => releaseNext.promise);
  const retirement = expect(contexts.retire([first])).rejects.toBe(failure);
  const finished = vi.fn();
  const finishing = expect(contexts.finish(admitted)).rejects.toBe(failure).then(finished);
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  releaseNext.resolve();
  await Promise.all([finishing, retirement]);
  await expect(contexts.retire([first])).rejects.toBe(failure);
  expect(previous.release).toHaveBeenCalledOnce();
  expect(next.release).toHaveBeenCalledOnce();
});

it.each(["idle", "unpublished"] as const)(
  "preserves %s cleanup failures on a deletion retry",
  async (mode) => {
    const contexts = new PreparedCatalogContexts<TestGeneration>();
    const prepared = mode === "idle" ? await seed(contexts, first) : generation();
    const active = mode === "unpublished" ? contexts.begin(identity(), first) : undefined;
    const cleanup = Promise.withResolvers<void>();
    const failure = new PluginRuntimeCloseRetainedError(new Error("native cleanup retained"));
    prepared.release.mockImplementation(() => cleanup.promise);
    const retirement = expect(contexts.retire([first])).rejects.toBe(failure);
    const duplicate = expect(contexts.retire([first])).rejects.toBe(failure);
    const release =
      active && expect(contexts.releaseGeneration(first, prepared)).rejects.toBe(failure);
    cleanup.reject(failure);
    await release;
    if (active) {
      await contexts.finish(active);
    }
    await Promise.all([retirement, duplicate]);
    await expect(contexts.retire([first])).rejects.toBe(failure);
    await contexts.retire([elsewhere]);
    expect(prepared.release).toHaveBeenCalledOnce();
  },
);

it("preserves retained scope-growth cleanup when outer disposal has a completed fault", async () => {
  const contexts = new PreparedCatalogContexts<TestGeneration>();
  const survivor = await seed(contexts, second, "survivor");
  const admission = contexts.begin(identity(), first);
  const nested = generation();
  const outer = generation();
  const retained = new PluginRuntimeCloseRetainedError(new Error("native cleanup retained"));
  const completed = new PluginRuntimeCloseCompletedError([], "outer callback failed");
  nested.release.mockRejectedValue(retained);
  outer.release.mockRejectedValue(completed);
  const retirement = expect(contexts.retire([first])).rejects.toBe(retained);
  const closeBoth = async () => {
    try {
      await contexts.releaseGeneration(first, nested);
    } finally {
      await contexts.releaseGeneration(first, outer);
    }
  };
  await expect(closeBoth()).rejects.toBe(completed);
  await contexts.finish(admission);
  await retirement;
  await expect(contexts.retire([first])).rejects.toBe(retained);
  const other = contexts.begin(identity("survivor"), second);
  expect(other.previous?.prepared).toBe(survivor);
  contexts.assertCurrent(other);
  await contexts.finish(other);
  expect(survivor.release).not.toHaveBeenCalled();
});

it("observes completed disposal faults without fencing a subsequent deletion", async () => {
  const contexts = new PreparedCatalogContexts<TestGeneration>();
  const prepared = await seed(contexts, first);
  const failure = new PluginRuntimeCloseCompletedError([], "callback failed after cleanup");
  prepared.release.mockRejectedValue(failure);
  await expect(contexts.retire([first])).rejects.toBe(failure);
  await contexts.retire([first]);
  expect(prepared.release).toHaveBeenCalledOnce();
});

it.each(["replacement", "scope growth", "failed replacement"])(
  "keeps shared predecessor cleanup with both owners during %s",
  async (mode) => {
    const contexts = new PreparedCatalogContexts<TestGeneration>();
    const predecessor = await seed(contexts, first);
    const neighbor = await seed(contexts, elsewhere, "neighbor");
    const admitted = contexts.begin(identity("workspace", "next"), second);
    const cleanup = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const candidateReleased = Promise.withResolvers<void>();
    const retained = new PluginRuntimeCloseRetainedError(new Error("predecessor retained"));
    predecessor.release.mockImplementation(() => {
      started.resolve();
      return cleanup.promise;
    });
    const releasePredecessor = predecessor.release;
    let finishing: Promise<void>;
    if (mode === "replacement") {
      contexts.publish(admitted, generation());
      finishing = contexts.finish(admitted);
    } else if (mode === "scope growth") {
      predecessor.release = generation().release;
      finishing = contexts
        .releaseGeneration(second, predecessor, releasePredecessor)
        .finally(() => contexts.finish(admitted));
    } else {
      const attempted = generation();
      attempted.release.mockImplementation(() => candidateReleased.promise);
      contexts.invalidate(admitted);
      finishing = contexts
        .releaseGeneration(second, attempted)
        .finally(() => contexts.finish(admitted));
    }
    const closed = expect(finishing).rejects.toBe(retained);
    const deletion = expect(contexts.retire([first])).rejects.toBe(retained);
    await contexts.retire(["unrelated"]);
    if (mode === "failed replacement") {
      expect(releasePredecessor).not.toHaveBeenCalled();
      candidateReleased.resolve();
    }
    await started.promise;
    cleanup.reject(retained);
    await Promise.all([closed, deletion]);
    await expect(contexts.retire([first])).rejects.toBe(retained);
    await expect(contexts.retire([second])).rejects.toBe(retained);
    expect(releasePredecessor).toHaveBeenCalledOnce();
    const other = contexts.begin(identity("neighbor"), elsewhere);
    expect(other.previous?.prepared).toBe(neighbor);
    contexts.assertCurrent(other);
    await contexts.finish(other);
    expect(neighbor.release).not.toHaveBeenCalled();
  },
);

it("releases failed replacements once and permits the same identity to be recreated", async () => {
  const contexts = new PreparedCatalogContexts<TestGeneration>();
  const previous = await seed(contexts, first);
  const admitted = contexts.begin(identity("workspace", "replacement"), first);
  contexts.invalidate(admitted);
  const retirement = contexts.retire([first]);
  await contexts.finish(admitted);
  await retirement;
  await contexts.retire([first]);
  expect(previous.release).toHaveBeenCalledOnce();
  const recreated = await seed(contexts, first);
  expect(contexts.get("workspace")?.prepared).toBe(recreated);
  expect(recreated.release).not.toHaveBeenCalled();
});

it.each([false, true])(
  "joins a successor detached while its predecessor releases (failure=%s)",
  async (rejectSuccessor) => {
    const contexts = new PreparedCatalogContexts<TestGeneration>();
    const previous = await seed(contexts, first);
    const admitted = contexts.begin(identity("workspace", "replacement"), first);
    const next = generation();
    contexts.publish(admitted, next);
    const previousReleased = Promise.withResolvers<void>();
    const nextStarted = Promise.withResolvers<void>();
    const nextReleased = Promise.withResolvers<void>();
    previous.release.mockImplementation(() => previousReleased.promise);
    next.release.mockImplementation(() => {
      nextStarted.resolve();
      return nextReleased.promise;
    });
    const failure = new Error("successor release failed");
    const finished = vi.fn();
    const finishing = contexts.finish(admitted);
    const finishingCheck = (
      rejectSuccessor ? expect(finishing).rejects.toBe(failure) : finishing
    ).then(finished);
    expect(previous.release).toHaveBeenCalledOnce();
    const retired = vi.fn();
    const retirement = contexts.retire([first]);
    const retirementCheck = (
      rejectSuccessor ? expect(retirement).rejects.toBe(failure) : retirement
    ).then(retired);
    previousReleased.resolve();
    await nextStarted.promise;
    expect(next.release).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    expect(retired).not.toHaveBeenCalled();
    if (rejectSuccessor) {
      nextReleased.reject(failure);
    } else {
      nextReleased.resolve();
    }
    await Promise.all([finishingCheck, retirementCheck]);
    expect(previous.release).toHaveBeenCalledOnce();
    expect(next.release).toHaveBeenCalledOnce();
    expect(contexts.get("workspace")).toBeUndefined();
  },
);

it("keeps catalog retirement distinct from database and unknown resource keys", () => {
  expect(decodePreparedCatalogRetirement(encodePreparedCatalogRetirement([first, second]))).toEqual(
    [first, second],
  );
  expect(decodePreparedCatalogRetirement("[]")).toBeUndefined();
  expect(decodePreparedCatalogRetirement()).toBeUndefined();
});
