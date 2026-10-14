import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { museEnvironment } from "./environment.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muse-environment-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", join(root, "state"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "native"));
  vi.stubEnv("TBH_CREDENTIAL_BACKEND", "keychain");
  vi.stubEnv("MUSE_FIXTURE_PARENT_VALUE", "inherited");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("preserves inherited PATH and terminal credentials when no managed file exists", async () => {
  const env = await museEnvironment(undefined, { MUSE_FIXTURE_CHILD_VALUE: "child" });
  expect(env).toMatchObject({
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: join(root, "native"),
    TBH_CREDENTIAL_BACKEND: "keychain",
    MUSE_NO_AUTO_UPDATE: "1",
    MUSE_FIXTURE_PARENT_VALUE: "inherited",
    MUSE_FIXTURE_CHILD_VALUE: "child",
  });
});

it.each(['{"providers":{"meta":{}}}', "malformed-json"])(
  "selects the managed file without using its contents to choose a fallback",
  async (contents) => {
    const home = join(root, "state", "muse");
    await mkdir(join(home, "muse"), { recursive: true });
    await writeFile(join(home, "muse", "auth.json"), contents);
    const env = await museEnvironment("synthetic-prepared-key", {
      MUSE_FIXTURE_CHILD_VALUE: "child",
    });
    expect(env).toMatchObject({
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: home,
      TBH_CREDENTIAL_BACKEND: "file",
      MUSE_NO_AUTO_UPDATE: "1",
      META_API_KEY: "synthetic-prepared-key",
      MUSE_FIXTURE_PARENT_VALUE: "inherited",
      MUSE_FIXTURE_CHILD_VALUE: "child",
    });
  },
);
