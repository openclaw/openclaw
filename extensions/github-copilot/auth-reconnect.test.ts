import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  interactiveContext,
  registerProviderWithPluginConfig,
  requireAuthMethod,
} from "./provider.test-support.js";

const mocks = vi.hoisted(() => ({
  resolveCopilotStarterModel: vi.fn(async () => "github-copilot/claude-sonnet-5"),
}));
vi.mock("./register.runtime.js", () => ({
  resolveCopilotStarterModel: mocks.resolveCopilotStarterModel,
}));
const profileId = "github-copilot:github";
const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.clearAllMocks();
    clearRuntimeAuthProfileStoreSnapshots();
    cleanup();
  }),
);
afterAll(() => {
  vi.doUnmock("./register.runtime.js");
  vi.resetModules();
});

it("fences starter discovery when reconnect authority is lost during token resolution", async () => {
  const agentDir = roots.make("copilot-reconnect-");
  const method = requireAuthMethod(registerProviderWithPluginConfig({}).auth, 0);
  let current = true;
  const revoked = new Error("Reconnect owner revoked");
  const env = {
    get SCOPED_COPILOT_TOKEN() {
      queueMicrotask(() => {
        current = false;
      });
      return "selected-owner-token";
    },
  };

  await expect(
    method.run({
      ...interactiveContext(agentDir),
      env,
      existingProfiles: [
        {
          profileId,
          credential: {
            type: "token",
            provider: "github-copilot",
            tokenRef: { source: "env", provider: "default", id: "SCOPED_COPILOT_TOKEN" },
          },
        },
      ],
      prompter: { confirm: vi.fn(async () => false), note: vi.fn() },
      openUrl: vi.fn(),
      assertCurrent: () => {
        if (!current) {
          throw revoked;
        }
      },
    }),
  ).rejects.toBe(revoked);
  expect(current).toBe(false);
  expect(mocks.resolveCopilotStarterModel).not.toHaveBeenCalled();
});
