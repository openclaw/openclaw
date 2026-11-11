import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { withFileMutationQueueKeysResolution } from "./file-mutation-queue.js";

it("reserves files in source-call order without holding admission while a file operation runs", async () => {
  const keys = createDeferred<readonly string[]>();
  const release = createDeferred();
  const events: string[] = [];
  const first = withFileMutationQueueKeysResolution(keys.promise, async () => {
    events.push("first");
    await release.promise;
  });
  const second = withFileMutationQueueKeysResolution(Promise.resolve(["same-file"]), async () => {
    events.push("second");
  });
  const unrelated = withFileMutationQueueKeysResolution(
    Promise.resolve(["other-file"]),
    async () => {
      events.push("unrelated");
    },
  );
  try {
    keys.resolve(["same-file"]);
    await unrelated;
    expect(events).toEqual(["first", "unrelated"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first", "unrelated", "second"]);
  } finally {
    keys.resolve(["same-file"]);
    release.resolve();
    await Promise.allSettled([first, second, unrelated]);
  }
});
