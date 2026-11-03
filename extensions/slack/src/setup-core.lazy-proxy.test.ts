import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup-runtime";
import { describe, expect, it, vi } from "vitest";
import { createSlackSetupWizardProxy } from "./setup-core.js";

function makeFakeWizard(overrides: Partial<ChannelSetupWizard> = {}): ChannelSetupWizard {
  return {
    channel: "slack",
    status: {
      resolveConfigured: vi.fn(async () => ({ configured: false })),
    },
    credentials: [],
    ...overrides,
  } as ChannelSetupWizard;
}

describe("createSlackSetupWizardProxy", () => {
  it("does not load the wizard module just by constructing the proxy", () => {
    const loader = vi.fn(async () => ({ slackSetupWizard: makeFakeWizard() }));
    const proxy = createSlackSetupWizardProxy(loader);
    expect(proxy.channel).toBe("slack");
    expect(loader).not.toHaveBeenCalled();
  });

  it("forwards allowFrom.resolveEntries to the lazily loaded wizard and propagates its result", async () => {
    const sentinel = [{ input: "U123", resolved: true, id: "U123" }];
    const resolveEntries = vi.fn(async () => sentinel);
    const fakeWizard = makeFakeWizard({
      allowFrom: {
        resolveEntries,
      } as unknown as ChannelSetupWizard["allowFrom"],
    });
    const loader = vi.fn(async () => ({ slackSetupWizard: fakeWizard }));
    const proxy = createSlackSetupWizardProxy(loader);

    const cfg = { channels: { slack: {} } } as never;
    const result = await proxy.allowFrom!.resolveEntries({
      cfg,
      accountId: "default",
      credentialValues: { botToken: "xoxb-bot" },
      entries: ["U123"],
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(resolveEntries).toHaveBeenCalledTimes(1);
    expect(resolveEntries).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      credentialValues: { botToken: "xoxb-bot" },
      entries: ["U123"],
    });
    expect(result).toBe(sentinel);
  });

  it("forwards groupAccess.resolveAllowlist when present and uses the configured fallback otherwise", async () => {
    const groupResolved = ["G1-resolved"];
    const resolveAllowlist = vi.fn(async () => groupResolved);
    const fakeWithGroupAccess = makeFakeWizard({
      groupAccess: {
        resolveAllowlist,
      } as unknown as ChannelSetupWizard["groupAccess"],
    });
    const loaderA = vi.fn(async () => ({ slackSetupWizard: fakeWithGroupAccess }));
    const proxyA = createSlackSetupWizardProxy(loaderA);

    const cfg = { channels: { slack: {} } } as never;
    const a = await proxyA.groupAccess!.resolveAllowlist!({
      cfg,
      accountId: "default",
      credentialValues: {},
      entries: ["G1"],
      prompter: undefined as never,
    });
    expect(resolveAllowlist).toHaveBeenCalledTimes(1);
    expect(a).toBe(groupResolved);

    const fakeNoGroupAccess = makeFakeWizard();
    const loaderB = vi.fn(async () => ({ slackSetupWizard: fakeNoGroupAccess }));
    const proxyB = createSlackSetupWizardProxy(loaderB);

    const b = await proxyB.groupAccess!.resolveAllowlist!({
      cfg,
      accountId: "default",
      credentialValues: {},
      entries: ["G1", "G2"],
      prompter: undefined as never,
    });
    expect(b).toEqual(["G1", "G2"]);
  });
});
