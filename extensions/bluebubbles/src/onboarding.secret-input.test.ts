import type { WizardPrompter } from "openclaw/plugin-sdk/compat";
import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  addWildcardAllowFrom: vi.fn(),
  formatDocsLink: (_url: string, fallback: string) => fallback,
  hasConfiguredSecretInput: (value: unknown) => {
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const ref = value as { source?: unknown; provider?: unknown; id?: unknown };
    const validSource = ref.source === "env" || ref.source === "file" || ref.source === "exec";
    return (
      validSource &&
      typeof ref.provider === "string" &&
      ref.provider.trim().length > 0 &&
      typeof ref.id === "string" &&
      ref.id.trim().length > 0
    );
  },
  mergeAllowFromEntries: (_existing: unknown, entries: string[]) => entries,
  normalizeSecretInputString: (value: unknown) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  normalizeAccountId: (value?: string | null) =>
    value && value.trim().length > 0 ? value : "default",
  promptAccountId: vi.fn(),
}));

describe("bluebubbles onboarding SecretInput", () => {
  it("preserves existing password SecretRef when user keeps current credential", async () => {
    const { blueBubblesOnboardingAdapter } = await import("./onboarding.js");
    type ConfigureContext = Parameters<
      NonNullable<typeof blueBubblesOnboardingAdapter.configure>
    >[0];
    const passwordRef = { source: "env", provider: "default", id: "BLUEBUBBLES_PASSWORD" };
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(true) // keep server URL
      .mockResolvedValueOnce(true) // keep password SecretRef
      .mockResolvedValueOnce(false); // keep default webhook path
    const text = vi.fn();
    const note = vi.fn();

    const prompter = {
      confirm,
      text,
      note,
    } as unknown as WizardPrompter;

    const context = {
      cfg: {
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://127.0.0.1:1234",
            password: passwordRef,
          },
        },
      },
      prompter,
      runtime: { ...console, exit: vi.fn() } as ConfigureContext["runtime"],
      forceAllowFrom: false,
      accountOverrides: {},
      shouldPromptAccountIds: false,
    } satisfies ConfigureContext;

    const result = await blueBubblesOnboardingAdapter.configure(context);

    expect(result.cfg.channels?.bluebubbles?.password).toEqual(passwordRef);
    expect(text).not.toHaveBeenCalled();
  });
});
