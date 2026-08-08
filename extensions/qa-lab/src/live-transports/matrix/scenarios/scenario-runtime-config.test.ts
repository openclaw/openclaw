import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  replaceMatrixQaGatewayMatrixAccount,
  runMatrixQaGatewayMatrixConfigTransaction,
} from "./scenario-runtime-config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createConfig(config: Record<string, unknown>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

async function readConfig(configPath: string) {
  return JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
}

async function runFailureCase(error: Error) {
  const original = {
    channels: {
      matrix: {
        accounts: { existing: { enabled: true } },
        defaultAccount: "existing",
        unknownValidField: { keep: true },
      },
    },
  };
  const configPath = await createConfig(original);
  const outcome = await runMatrixQaGatewayMatrixConfigTransaction({
    applyRestoration: async (restore) => await restore(),
    configPath,
    run: async () => {
      await replaceMatrixQaGatewayMatrixAccount({
        accountConfig: { enabled: true },
        accountId: "temporary",
        configPath,
      });
      throw error;
    },
  }).catch((caught: unknown) => caught);
  expect(outcome).toBe(error);
  expect(await readConfig(configPath)).toEqual(original);
}

describe("Matrix QA gateway config transaction", () => {
  it("preserves sibling accounts and defaults during setup, then restores exactly", async () => {
    const original = {
      channels: {
        matrix: {
          accounts: {
            default: { enabled: true },
            sibling: { enabled: false, unknownAccountField: 1 },
          },
          defaultAccount: "default",
          unknownValidField: ["keep"],
        },
      },
    };
    const configPath = await createConfig(original);

    await expect(
      runMatrixQaGatewayMatrixConfigTransaction({
        applyRestoration: async (restore) => await restore(),
        configPath,
        run: async () => {
          await replaceMatrixQaGatewayMatrixAccount({
            accountConfig: { enabled: true },
            accountId: "temporary",
            configPath,
          });
          expect(await readConfig(configPath)).toEqual({
            channels: {
              matrix: {
                ...original.channels.matrix,
                accounts: {
                  ...original.channels.matrix.accounts,
                  temporary: { enabled: true },
                },
              },
            },
          });
          return "ok";
        },
      }),
    ).resolves.toBe("ok");
    expect(await readConfig(configPath)).toEqual(original);
  });

  it("restores after setup and CLI failures", async () => {
    await runFailureCase(new Error("setup failed"));
    await runFailureCase(new Error("CLI failed"));
  });

  it("restores after abort", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    await runFailureCase(abort);
  });

  it("restores an originally absent Matrix config without leaving empty channels", async () => {
    const original = { plugins: { entries: { matrix: { enabled: true } } } };
    const configPath = await createConfig(original);
    await runMatrixQaGatewayMatrixConfigTransaction({
      applyRestoration: async (restore) => await restore(),
      configPath,
      run: async () => {
        await replaceMatrixQaGatewayMatrixAccount({
          accountConfig: { enabled: true },
          accountId: "temporary",
          configPath,
        });
      },
    });
    expect(await readConfig(configPath)).toEqual(original);
  });

  it("surfaces restoration failure, including after a scenario failure", async () => {
    const configPath = await createConfig({});
    const scenarioError = new Error("scenario failed");
    const restorationError = new Error("restoration failed");
    const outcome = await runMatrixQaGatewayMatrixConfigTransaction({
      applyRestoration: async () => {
        throw restorationError;
      },
      configPath,
      run: async () => {
        throw scenarioError;
      },
    }).catch((caught: unknown) => caught);

    expect(outcome).toMatchObject({
      cause: scenarioError,
      errors: [scenarioError, restorationError],
      message: "Matrix QA gateway config transaction failed",
    });
  });
});
