// Matrix tests cover credentials store locality against the installed plugin runtime.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../runtime.js";
import {
  captureMatrixCredentialsEnv,
  openMatrixCredentialsAsyncStore,
} from "./credentials-read.js";

const RUNTIME_STATE_DIR = "/runtime/state";
const CALLER_STATE_DIR = "/caller/state";

function captureOpenedStateDir(env: NodeJS.ProcessEnv) {
  const openKeyedStoreV2 = vi.fn(() => ({}) as never);
  setMatrixRuntime({
    state: {
      resolveStateDir: () => RUNTIME_STATE_DIR,
      openKeyedStoreV2,
    },
  } as never);
  openMatrixCredentialsAsyncStore(env);
  const options = openKeyedStoreV2.mock.calls[0]?.[0] as { env?: NodeJS.ProcessEnv } | undefined;
  return options?.env?.OPENCLAW_STATE_DIR;
}

describe("matrix credentials store locality", () => {
  afterEach(() => {
    setMatrixRuntime(undefined as never);
  });

  it("opens the store where capture-based reads resolve it", () => {
    const env = { OPENCLAW_STATE_DIR: CALLER_STATE_DIR };

    expect(captureOpenedStateDir(env)).toBe(captureMatrixCredentialsEnv(env).OPENCLAW_STATE_DIR);
  });

  it("prefers the installed runtime state dir over a caller env override", () => {
    const env = { OPENCLAW_STATE_DIR: CALLER_STATE_DIR };

    expect(captureOpenedStateDir(env)).toBe(RUNTIME_STATE_DIR);
  });

  it("keeps the caller env override when no runtime is installed", () => {
    setMatrixRuntime(undefined as never);
    const openKeyedStoreV2 = vi.fn(() => ({}) as never);

    expect(openKeyedStoreV2).not.toHaveBeenCalled();
    expect(
      captureMatrixCredentialsEnv({ OPENCLAW_STATE_DIR: CALLER_STATE_DIR }).OPENCLAW_STATE_DIR,
    ).toBe(CALLER_STATE_DIR);
  });
});
