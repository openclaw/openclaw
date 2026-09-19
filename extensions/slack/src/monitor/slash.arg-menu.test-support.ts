// Local Bolt harness used by Slack native command argument-menu tests.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { vi } from "vitest";

export function createArgMenusHarness(
  cfg: OpenClawConfig = { commands: { native: true, nativeSkills: false } },
  scope?: {
    installationIdentity?:
      | { kind: "workspace"; teamId: string }
      | { kind: "enterprise"; enterpriseId: string };
    teamId?: string;
  },
) {
  const commands = new Map<string | RegExp, (args: unknown) => Promise<void>>();
  const commandRegistrations: Array<string | RegExp> = [];
  const actions = new Map<string | RegExp, (args: unknown) => Promise<void>>();
  const options = new Map<string, (args: unknown) => Promise<void>>();
  const optionsReceiverContexts: unknown[] = [];
  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const listenerClient = { chat: { postEphemeral } };
  const installationIdentity = scope?.installationIdentity ?? {
    kind: "workspace" as const,
    teamId: scope?.teamId ?? "T1",
  };
  const boltContext =
    installationIdentity.kind === "enterprise"
      ? {
          teamId: scope?.teamId,
          enterpriseId: installationIdentity.enterpriseId,
          isEnterpriseInstall: true,
        }
      : { teamId: installationIdentity.teamId, isEnterpriseInstall: false };
  const withBoltScope = (args: unknown) => {
    const typed = args as { context?: Record<string, unknown>; client?: unknown };
    return {
      ...typed,
      context: { ...boltContext, ...typed.context },
      client: typed.client ?? listenerClient,
    };
  };
  const app = {
    client: listenerClient,
    command: (name: string | RegExp, handler: (args: unknown) => Promise<void>) => {
      commandRegistrations.push(name);
      commands.set(name, async (args) => await handler(withBoltScope(args)));
    },
    action: (id: string | RegExp, handler: (args: unknown) => Promise<void>) => {
      actions.set(id, async (args) => await handler(withBoltScope(args)));
    },
    options(this: unknown, id: string, handler: (args: unknown) => Promise<void>) {
      optionsReceiverContexts.push(this);
      options.set(id, async (args) => await handler(withBoltScope(args)));
    },
  };
  const ctx = {
    cfg,
    runtime: {},
    botToken: "bot-token",
    botUserId: "bot",
    teamId: installationIdentity.kind === "enterprise" ? "" : installationIdentity.teamId,
    installationIdentity,
    allowFrom: ["*"],
    dmEnabled: true,
    dmPolicy: "open",
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: "open",
    useAccessGroups: false,
    channelsConfig: undefined,
    slashCommand: {
      enabled: false,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    app,
    isChannelAllowed: () => true,
    resolveChannelName: async () => ({ name: "dm", type: "im" }),
    resolveUserName: async () => ({ name: "Ada" }),
  };
  Object.assign(ctx, { readRuntimeContext: async () => ctx, isRuntimePolicyCurrent: () => true });
  const account = {
    accountId: "acct",
    config: { commands: { native: true, nativeSkills: false } },
  } as unknown;
  return {
    commandRegistrations,
    commands,
    actions,
    options,
    optionsReceiverContexts,
    postEphemeral,
    ctx,
    account,
    app,
  };
}
