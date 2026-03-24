import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeApiExportTypesViaJiti } from "../../test/helpers/extensions/jiti-runtime-api.ts";

const setMatrixRuntimeMock = vi.hoisted(() => vi.fn());
const registerChannelMock = vi.hoisted(() => vi.fn());

vi.mock("./src/runtime.js", () => ({
  setMatrixRuntime: setMatrixRuntimeMock,
}));

const { default: matrixPlugin } = await import("./index.js");

function createMatrixRuntimeApiAliasShims() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-jiti-"));
  const writeShim = (fileName: string, contents: string) => {
    const filePath = path.join(fixtureRoot, fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
    return filePath;
  };

  const accountIdShim = writeShim(
    "plugin-sdk/account-id.ts",
    `export const DEFAULT_ACCOUNT_ID = "default";
export const normalizeAccountId = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ACCOUNT_ID;
export const normalizeOptionalAccountId = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
`,
  );
  const accountResolutionShim = writeShim(
    "plugin-sdk/account-resolution.ts",
    `export const listCombinedAccountIds = ({ configuredAccountIds = [], additionalAccountIds = [], fallbackAccountIdWhenEmpty }) => {
  const ids = [...configuredAccountIds, ...additionalAccountIds].filter((value) => typeof value === "string" && value.length > 0);
  if (ids.length === 0 && typeof fallbackAccountIdWhenEmpty === "string" && fallbackAccountIdWhenEmpty.length > 0) {
    ids.push(fallbackAccountIdWhenEmpty);
  }
  return Array.from(new Set(ids));
};
export const listConfiguredAccountIds = ({ accounts = {}, normalizeAccountId }) =>
  Object.keys(accounts).map((id) => normalizeAccountId(id));
export const resolveListedDefaultAccountId = ({ accountIds = [], configuredDefaultAccountId, ambiguousFallbackAccountId }) =>
  configuredDefaultAccountId && accountIds.includes(configuredDefaultAccountId)
    ? configuredDefaultAccountId
    : accountIds.length === 1
      ? accountIds[0]
      : ambiguousFallbackAccountId;
export const resolveNormalizedAccountEntry = (accounts = {}, accountId, normalizeAccountId) =>
  accounts[normalizeAccountId(accountId)];
`,
  );
  const matrixShim = writeShim(
    "plugin-sdk/matrix.ts",
    `export const resolveMatrixAccountStringValues = () => ({});
export const formatZonedTimestamp = () => "timestamp";
`,
  );
  const infraRuntimeShim = writeShim(
    "plugin-sdk/infra-runtime.ts",
    `export const assertHttpUrlTargetsPrivateNetwork = () => {};
export const closeDispatcher = () => {};
export const createPinnedDispatcher = () => ({});
export const resolvePinnedHostnameWithPolicy = async () => "127.0.0.1";
export const ssrfPolicyFromAllowPrivateNetwork = () => ({});
`,
  );
  const matrixRuntimeHeavyShim = writeShim(
    "plugin-sdk/matrix-runtime-heavy.ts",
    `export const dispatchReplyFromConfigWithSettledDispatcher = async () => ({});
export const ensureConfiguredAcpBindingReady = async () => undefined;
export const maybeCreateMatrixMigrationSnapshot = () => null;
export const resolveConfiguredAcpBindingRecord = () => null;
`,
  );
  const ssrfRuntimeShim = writeShim(
    "plugin-sdk/ssrf-runtime.ts",
    `export const assertHttpUrlTargetsPrivateNetwork = () => {};
export const closeDispatcher = () => {};
export const createPinnedDispatcher = () => ({});
export const resolvePinnedHostnameWithPolicy = async () => "127.0.0.1";
export const ssrfPolicyFromAllowPrivateNetwork = () => ({});
`,
  );
  const jsonStoreShim = writeShim(
    "plugin-sdk/json-store.ts",
    `export const writeJsonFileAtomically = async () => undefined;
`,
  );
  const configRuntimeShim = writeShim(
    "plugin-sdk/config-runtime.ts",
    `export {};
`,
  );

  const aliases = {
    "openclaw/plugin-sdk/account-id": accountIdShim,
    "openclaw/plugin-sdk/account-resolution": accountResolutionShim,
    "openclaw/plugin-sdk/config-runtime": configRuntimeShim,
    "openclaw/plugin-sdk/matrix": matrixShim,
    "openclaw/plugin-sdk/infra-runtime": infraRuntimeShim,
    "openclaw/plugin-sdk/matrix-runtime-heavy": matrixRuntimeHeavyShim,
    "openclaw/plugin-sdk/ssrf-runtime": ssrfRuntimeShim,
    "openclaw/plugin-sdk/json-store": jsonStoreShim,
  } as const;

  return {
    aliases,
    dispose: () => fs.rmSync(fixtureRoot, { recursive: true, force: true }),
  };
}

describe("matrix plugin registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the matrix runtime api through Jiti", () => {
    const runtimeApiPath = path.join(process.cwd(), "extensions", "matrix", "runtime-api.ts");
    const shims = createMatrixRuntimeApiAliasShims();
    try {
      expect(
        loadRuntimeApiExportTypesViaJiti({
          modulePath: runtimeApiPath,
          exportNames: [
            "requiresExplicitMatrixDefaultAccount",
            "resolveMatrixDefaultOrOnlyAccountId",
          ],
          additionalAliases: shims.aliases,
        }),
      ).toEqual({
        requiresExplicitMatrixDefaultAccount: "function",
        resolveMatrixDefaultOrOnlyAccountId: "function",
      });
    } finally {
      shims.dispose();
    }
  }, 240_000);

  it("loads the matrix src runtime api through Jiti without duplicate export errors", () => {
    const runtimeApiPath = path.join(
      process.cwd(),
      "extensions",
      "matrix",
      "src",
      "runtime-api.ts",
    );
    const shims = createMatrixRuntimeApiAliasShims();
    try {
      expect(
        loadRuntimeApiExportTypesViaJiti({
          modulePath: runtimeApiPath,
          exportNames: ["resolveMatrixAccountStringValues"],
          additionalAliases: shims.aliases,
        }),
      ).toEqual({
        resolveMatrixAccountStringValues: "function",
      });
    } finally {
      shims.dispose();
    }
  }, 240_000);

  it("registers the channel without bootstrapping crypto runtime", () => {
    const runtime = {} as never;
    matrixPlugin.register({
      runtime,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      registerChannel: registerChannelMock,
    } as never);

    expect(setMatrixRuntimeMock).toHaveBeenCalledWith(runtime);
    expect(registerChannelMock).toHaveBeenCalledWith({ plugin: expect.any(Object) });
  });
});
