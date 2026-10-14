import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentHarnessSetupVerificationContext } from "openclaw/plugin-sdk/agent-harness";
import { afterEach, expect, it, vi } from "vitest";
import { verifyMuseSetup } from "./verify-setup.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const workspaceDir = await mkdtemp(join(tmpdir(), "muse-verify-"));
  directories.push(workspaceDir);
  const log = join(workspaceDir, "requests.jsonl");
  vi.stubEnv("MUSE_REQUEST_LOG", log);
  vi.stubEnv("MUSE_FIXTURE_CATALOG_SOURCE", "providerCatalog");
  vi.stubEnv("META_API_KEY", "synthetic-working-key");
  vi.stubEnv("OPENCLAW_STATE_DIR", join(workspaceDir, "state"));
  vi.stubEnv("TBH_CREDENTIAL_BACKEND", undefined);
  const ctx: AgentHarnessSetupVerificationContext = {
    config: {
      plugins: {
        entries: {
          muse: {
            config: {
              binaryPath: fileURLToPath(new URL("./test-support/fake-muse.mjs", import.meta.url)),
            },
          },
        },
      },
    },
    provider: "meta",
    modelId: "muse-spark-1.3",
    workspaceDir,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
  };
  return { ctx, log };
}

it("verifies a live authenticated catalog without starting a turn or a session", async () => {
  const { ctx, log } = await setup();
  await verifyMuseSetup(ctx);
  const requests = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(requests.filter((request) => request.method).map((request) => request.method)).toEqual([
    "initialize",
    "initialized",
    "model/list",
  ]);
  expect(requests[0].args).toEqual([
    "serve",
    "--no-session-log",
    "--disable-shell",
    "--disable-write",
  ]);
});

it("rejects a credential that cannot access the selected model", async () => {
  const { ctx } = await setup();
  vi.stubEnv("META_API_KEY", "rejected-test-key");
  await expect(verifyMuseSetup(ctx)).rejects.toThrow("Sign in again");
});

it("rejects a bundled catalog even when it advertises the selected model", async () => {
  const { ctx } = await setup();
  vi.stubEnv("MUSE_FIXTURE_CATALOG_SOURCE", "bundledCatalog");
  await expect(verifyMuseSetup(ctx)).rejects.toThrow("could not authenticate access");
});

it.runIf(process.platform !== "win32")(
  "finds Muse on inherited PATH even when the selected workspace does not exist",
  async () => {
    const { ctx, log } = await setup();
    const bin = join(ctx.workspaceDir, "bin");
    await mkdir(bin);
    const fixture = fileURLToPath(new URL("./test-support/fake-muse.mjs", import.meta.url));
    await writeFile(
      join(bin, "muse"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
      { mode: 0o755 },
    );
    const inheritedPath = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    vi.stubEnv("PATH", inheritedPath);
    vi.stubEnv("MUSE_FIXTURE_INHERITED_VALUE", "inherited-fixture-value");
    ctx.config = {};
    ctx.workspaceDir = join(ctx.workspaceDir, "absent", "workspace");
    await verifyMuseSetup(ctx);
    const requests = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests[0]).toMatchObject({
      event: "spawn",
      path: inheritedPath,
      inheritedValue: "inherited-fixture-value",
      noAutoUpdate: "1",
    });
    expect(requests.filter((request) => request.method).map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
    ]);
  },
);
