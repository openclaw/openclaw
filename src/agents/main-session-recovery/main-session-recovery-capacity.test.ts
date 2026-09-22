import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createMainSessionRecoveryCapacity } from "./main-session-recovery-capacity.js";

it("bounds restored recovery until the active run settles", async () => {
  const capacity = createMainSessionRecoveryCapacity({ limit: 1 });
  const release = await capacity.acquire(() => true);
  expect(release).toBeTypeOf("function");
  const acquired = createDeferred();
  const pending = capacity
    .acquire(() => true)
    .then((nextRelease) => {
      expect(nextRelease).toBeTypeOf("function");
      nextRelease?.();
      acquired.resolve();
    });
  await expect(Promise.race([acquired.promise, Promise.resolve("pending")])).resolves.toBe(
    "pending",
  );
  release?.();
  await pending;
});
