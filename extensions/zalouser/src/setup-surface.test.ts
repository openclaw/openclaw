import { installChannelDmPolicyContractSuite } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  checkZaloAuthenticatedMock,
  logoutZaloProfileMock,
  resolveZaloAllowFromEntriesMock,
  resolveZaloGroupsByEntriesMock,
  startZaloQrLoginMock,
} from "./zalo-js.test-mocks.js";
import { zalouserSetupWizard } from "./setup-surface.js";
import { zalouserSetupPlugin } from "./setup-test-helpers.js";

type Prompter = ReturnType<typeof createTestWizardPrompter>;
const zalouserConfigure = createPluginSetupWizardConfigure(zalouserSetupPlugin);

function runSetup({
  prompts,
  ...params
}: {
  cfg?: OpenClawConfig;
  prompts?: Parameters<typeof createPrompter>[0];
  accountOverrides?: Record<string, string>;
  options?: Record<string, unknown>;
  forceAllowFrom?: boolean;
} = {}) {
  return runSetupWizardConfigure({
    configure: zalouserConfigure,
    prompter: createPrompter(prompts),
    ...params,
  });
}

function createPrompter(params?: {
  login?: boolean;
  note?: Prompter["note"];
  seen?: string[];
  dmPolicy?: "pairing" | "allowlist" | "open";
  groupAccess?: boolean;
  groupPolicy?: "allowlist";
  textByMessage?: Record<string, string>;
}) {
  const fallback = createTestWizardPrompter();
  const choices: Record<string, string | undefined> = {
    "Zalo Personal DM policy": params?.dmPolicy,
    "Zalo groups access": params?.groupPolicy,
  };
  const select = vi.fn(async (input: Parameters<Prompter["select"]>[0]) => {
    params?.seen?.push(input.message);
    return choices[input.message] ?? fallback.select(input);
  }) as Prompter["select"];
  const text = vi.fn(
    async ({ message }: { message: string }) => params?.textByMessage?.[message] ?? "",
  ) as Prompter["text"];
  return createTestWizardPrompter({
    ...(params?.note ? { note: params.note } : {}),
    confirm: vi.fn(async ({ message }: { message: string }) => {
      params?.seen?.push(message);
      return (
        (message === "Configure Zalo groups access?" && (params?.groupAccess ?? false)) ||
        (message === "Login via QR code now?" && (params?.login ?? false))
      );
    }),
    select,
    text,
  });
}

function expectEnabledDefaultSetup(
  result: Awaited<ReturnType<typeof runSetup>>,
  dmPolicy?: "pairing" | "allowlist",
) {
  expect(result).toMatchObject({
    accountId: "default",
    cfg: {
      channels: { zalouser: { enabled: true, ...(dmPolicy ? { dmPolicy } : {}) } },
      plugins: { entries: { zalouser: { enabled: true } } },
    },
  });
}

function runQuickstart(prompts: Parameters<typeof createPrompter>[0]) {
  return runSetup({ prompts, options: { quickstartDefaults: true } });
}

it.each(["configure", "status"] as const)(
  "checks %s without persisting refreshed session credentials",
  async (route) => {
    checkZaloAuthenticatedMock.mockClear();
    if (route === "configure") {
      expectEnabledDefaultSetup(await runSetup());
    } else {
      checkZaloAuthenticatedMock.mockResolvedValueOnce(true);
      await expect(zalouserSetupWizard.status.resolveConfigured({ cfg: {} })).resolves.toBe(true);
    }
    expect(checkZaloAuthenticatedMock).toHaveBeenCalledWith("default", {
      credentialPersistence: "read-only",
    });
  },
);

it.each([false, true])("guards first-time QR persistence (allowed=%s)", async (allowed) => {
  checkZaloAuthenticatedMock.mockResolvedValueOnce(false);
  startZaloQrLoginMock.mockClear();
  const guardError = new Error("verified inference changed");
  const beforePersistentEffect = vi.fn(async () => {
    if (!allowed) {
      throw guardError;
    }
  });
  const setup = runSetup({ prompts: { login: true }, options: { beforePersistentEffect } });
  if (allowed) {
    await setup;
    expect(startZaloQrLoginMock).toHaveBeenCalledWith({
      profile: "default",
      timeoutMs: 35_000,
      beforeCredentialPersistence: beforePersistentEffect,
    });
  } else {
    await expect(setup).rejects.toBe(guardError);
    expect(startZaloQrLoginMock).not.toHaveBeenCalled();
  }
  expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
});

it("revalidates between logging out and starting replacement QR login", async () => {
  checkZaloAuthenticatedMock.mockResolvedValueOnce(true);
  logoutZaloProfileMock.mockClear();
  startZaloQrLoginMock.mockClear();
  const guardError = new Error("verified inference changed");
  const beforePersistentEffect = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(guardError);
  await expect(runSetup({ options: { beforePersistentEffect } })).rejects.toBe(guardError);

  expect(beforePersistentEffect).toHaveBeenCalledTimes(2);
  expect(logoutZaloProfileMock).toHaveBeenCalledWith("default", { assertCurrent: undefined });
  expect(startZaloQrLoginMock).not.toHaveBeenCalled();
  expect(beforePersistentEffect.mock.invocationCallOrder[0]).toBeLessThan(
    logoutZaloProfileMock.mock.invocationCallOrder[0]!,
  );
  expect(logoutZaloProfileMock.mock.invocationCallOrder[0]).toBeLessThan(
    beforePersistentEffect.mock.invocationCallOrder[1]!,
  );
});

it("prompts DM policy before group access in quickstart", async () => {
  const seen: string[] = [];
  const result = await runQuickstart({ seen, dmPolicy: "pairing" });

  expectEnabledDefaultSetup(result, "pairing");
  expect(seen.indexOf("Zalo Personal DM policy")).toBeGreaterThanOrEqual(0);
  expect(seen.indexOf("Configure Zalo groups access?")).toBeGreaterThanOrEqual(0);
  expect(seen.indexOf("Zalo Personal DM policy")).toBeLessThan(
    seen.indexOf("Configure Zalo groups access?"),
  );
});

it.each(["DM", "group"] as const)("warns for an empty %s allowlist", async (scope) => {
  const note = vi.fn(async (_message: string, _title?: string) => {});
  const result =
    scope === "DM"
      ? await runQuickstart({ note, dmPolicy: "allowlist" })
      : await runSetup({ prompts: { note, groupAccess: true, groupPolicy: "allowlist" } });
  if (scope === "DM") {
    expectEnabledDefaultSetup(result, "allowlist");
    expect(result.cfg.channels?.zalouser?.allowFrom).toStrictEqual([]);
  } else {
    expect(result.cfg.channels?.zalouser).toMatchObject({ groupPolicy: "allowlist" });
    expect(result.cfg.channels?.zalouser?.groups).toStrictEqual({});
  }
  expect(
    note.mock.calls.some(([message]) =>
      message.includes(`No ${scope} allowlist entries added yet.`),
    ),
  ).toBe(true);
});

it("writes canonical enabled entries for configured groups", async () => {
  resolveZaloGroupsByEntriesMock.mockClear();
  const result = await runSetup({
    prompts: {
      groupAccess: true,
      groupPolicy: "allowlist",
      textByMessage: { "Zalo groups allowlist (comma-separated)": "Family, Work" },
    },
  });

  expect(result.cfg.channels?.zalouser?.groups).toEqual({
    Family: { enabled: true, requireMention: true },
    Work: { enabled: true, requireMention: true },
  });
  expect(resolveZaloGroupsByEntriesMock).toHaveBeenCalledWith({
    profile: "default",
    entries: ["Family", "Work"],
    credentialPersistence: "read-only",
  });
});

it("resolves setup DM allowlists without persisting refreshed credentials", async () => {
  resolveZaloAllowFromEntriesMock.mockClear();
  await runSetup({
    prompts: { textByMessage: { "Zalouser allowFrom (name or user id)": "Alice" } },
    forceAllowFrom: true,
  });

  expect(resolveZaloAllowFromEntriesMock).toHaveBeenCalledWith({
    profile: "default",
    entries: ["Alice"],
    credentialPersistence: "read-only",
  });
});

it("allowlists the plugin when a plugin allowlist already exists", async () => {
  const result = await runSetup({
    cfg: { plugins: { allow: ["telegram"] } },
  });

  expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
  expect(result.cfg.plugins?.allow).toEqual(["telegram", "zalouser"]);
});

installChannelDmPolicyContractSuite({
  dmPolicy: zalouserSetupWizard.dmPolicy!,
  cases: [
    {
      name: "Zalo Personal named accounts",
      channel: "zalouser",
      accountId: "work",
      accountConfig: { profile: "work" },
      inheritedAllowFrom: ["123456789"],
      defaultAccount: { rootAllowFrom: ["123456789"] },
    },
  ],
});

it.each(["pairing", "open"] as const)(
  "sets %s policy on the quickstart account",
  async (policy) => {
    const note = vi.fn(async (_message: string, _title?: string) => {});

    const result = await runSetup({
      cfg: {
        channels: {
          zalouser: {
            dmPolicy: "disabled",
            accounts: {
              default: { profile: "default", dmPolicy: "disabled" },
              work: {
                profile: "work",
                dmPolicy: "allowlist",
                allowFrom: ["123456789"],
              },
            },
          },
        },
      } as OpenClawConfig,
      prompts: { note, dmPolicy: policy },
      options: { quickstartDefaults: true },
      accountOverrides: { zalouser: "work" },
    });

    expect(
      note.mock.calls.some(([message]) =>
        message.includes("Current: dmPolicy=allowlist, allowFrom=123456789"),
      ),
    ).toBe(true);
    expect(result.cfg.channels?.zalouser?.accounts?.default?.dmPolicy).toBe("disabled");
    expect(result.cfg.channels?.zalouser?.accounts?.work).toMatchObject({
      dmPolicy: policy,
      allowFrom: policy === "open" ? ["123456789", "*"] : ["123456789"],
    });
  },
);
