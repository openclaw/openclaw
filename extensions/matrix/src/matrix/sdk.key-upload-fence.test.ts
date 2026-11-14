import { EventEmitter } from "node:events";
import "fake-indexeddb/auto";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { testKeyUploadFenceModes } from "./sdk.key-upload-fence.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
    vi.unstubAllEnvs();
  }),
);

let lastCreateClientOpts: { fetchFn?: typeof fetch } | null = null;

vi.mock("matrix-js-sdk/lib/matrix.js", async () => {
  const actual = await vi.importActual<typeof import("matrix-js-sdk/lib/matrix.js")>(
    "matrix-js-sdk/lib/matrix.js",
  );
  return {
    ...actual,
    createClient: vi.fn((opts: { fetchFn?: typeof fetch }) => {
      lastCreateClientOpts = opts;
      return Object.assign(new EventEmitter(), {
        startClient: vi.fn(async () => {}),
        stopClient: vi.fn(),
        decryptEventIfNeeded: vi.fn(async () => {}),
        getUserId: vi.fn(() => "@bot:example.org"),
        getDeviceId: vi.fn(() => "DEVICE123"),
        getCrypto: vi.fn(() => undefined),
      });
    }),
  };
});

const { MatrixClient } = await import("./sdk.js");

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("matrix-sdk-state-"));
});

describe("MatrixClient key upload fence", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    lastCreateClientOpts = null;
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  testKeyUploadFenceModes({
    MatrixClient,
    makeTempDir: () => tempDirs.make("matrix-key-upload-"),
    getFetchFn: () => {
      const fetchFn = lastCreateClientOpts?.fetchFn;
      if (!fetchFn) {
        throw new Error("Matrix client did not register its fetch transport");
      }
      return fetchFn;
    },
  });
});
