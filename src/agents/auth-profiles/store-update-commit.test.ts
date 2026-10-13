import { realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  waitForAuthProfileNativePublications,
  watchAuthProfileNativeCommits,
} from "./store-update-commit.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it("joins live publications through shared-source observers without retaining retired ones", async () => {
  const pathname = path.join(
    realpathSync(temporary.make("auth-publication-settlement-")),
    "auth.sqlite",
  );
  const first = watchAuthProfileNativeCommits(pathname);
  let settled = false;
  const waiting = waitForAuthProfileNativePublications([pathname]).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  const second = watchAuthProfileNativeCommits(pathname);
  first.dispose();
  await Promise.resolve();
  expect(settled).toBe(false);
  second.dispose();

  await waiting;

  expect(settled).toBe(true);
  await waitForAuthProfileNativePublications([pathname]);
});
