import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv, WizardPrompter } from "../runtime-api.js";
import type { CoreConfig } from "./types.js";

const resolveMatrixTargetsMock = vi.hoisted(() =>
  vi.fn(async () => [{ input: "Alice", resolved: true, id: "@alice:example.org" }]),
);

vi.mock("./resolve-targets.js", () => ({
  resolveMatrixTargets: resolveMatrixTargetsMock,
}));

import { matrixOnboardingAdapter } from "./onboarding.js";
import { setMatrixRuntime } from "./runtime.js";

describe("matrix onboarding account-scoped resolution", () => {
  beforeEach(() => {
    setMatrixRuntime({
      state: {
        resolveStateDir: (_env: NodeJS.ProcessEnv, homeDir?: () => string) =>
          (homeDir ?? (() => "/tmp"))(),
      },
      config: {
        loadConfig: () => ({}),
      },
    } as never);
    resolveMatrixTargetsMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes accountId into Matrix allowlist target resolution during onboarding", async () => {
    const prompter = {
      note: vi.fn(async () => {}),
      select: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Matrix already configured. What do you want to do?") {
          return "add-account";
        }
        if (message === "Matrix auth method") {
          return "token";
        }
        if (message === "Matrix rooms access") {
          return "allowlist";
        }
        throw new Error(`unexpected select prompt: ${message}`);
      }),
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Matrix account name") {
          return "ops";
        }
        if (message === "Matrix homeserver URL") {
          return "https://matrix.ops.example.org";
        }
        if (message === "Matrix access token") {
          return "ops-token";
        }
        if (message === "Matrix device name (optional)") {
          return "";
        }
        if (message === "Matrix allowFrom (full @user:server; display name only if unique)") {
          return "Alice";
        }
        if (message === "Matrix rooms allowlist (comma-separated)") {
          return "";
        }
        throw new Error(`unexpected text prompt: ${message}`);
      }),
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enable end-to-end encryption (E2EE)?") {
          return false;
        }
        if (message === "Configure Matrix rooms access?") {
          return true;
        }
        return false;
      }),
    } as unknown as WizardPrompter;

    const result = await matrixOnboardingAdapter.configureInteractive!({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                homeserver: "https://matrix.main.example.org",
                accessToken: "main-token",
              },
            },
          },
        },
      } as CoreConfig,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
      prompter,
      options: undefined,
      accountOverrides: {},
      shouldPromptAccountIds: true,
      forceAllowFrom: true,
      configured: true,
      label: "Matrix",
    });

    expect(result).not.toBe("skip");
    expect(resolveMatrixTargetsMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      accountId: "ops",
      inputs: ["Alice"],
      kind: "user",
    });
  });
});
