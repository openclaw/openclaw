import { loadBundledEntryExportSync } from "openclaw/plugin-sdk/channel-entry-contract";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostRegisteredCommand } from "./slash-commands.js";
import { activateSlashCommands, deactivateSlashCommands } from "./slash-state.js";

function createResolvedMattermostAccount(accountId: string): ResolvedMattermostAccount {
  return {
    accountId,
    enabled: true,
    botTokenSource: "config",
    baseUrlSource: "config",
    config: {},
  };
}

function createRegisteredCommand(params?: {
  token?: string;
  teamId?: string;
  trigger?: string;
}): MattermostRegisteredCommand {
  return {
    id: "cmd-1",
    teamId: params?.teamId ?? "team-1",
    trigger: params?.trigger ?? "oc_status",
    token: params?.token ?? "valid-token",
    url: "https://gateway.example.com/slash",
    managed: false,
  };
}

const slashApi = {
  cfg: {},
  runtime: {
    log: () => {},
    error: () => {},
    exit: () => {},
  },
} satisfies {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
};

afterEach(() => {
  deactivateSlashCommands();
});

describe("slash-state dual loader", () => {
  it("shares activated slash state between the bundled-entry loader path and native ESM imports", () => {
    const resolveFromBundledLoader = loadBundledEntryExportSync<
      (token: string) => {
        kind: "none" | "single" | "ambiguous";
        accountIds?: string[];
        source?: "token" | "command";
      }
    >(new URL("../../index.ts", import.meta.url).href, {
      specifier: "./src/mattermost/slash-shared-state.js",
      exportName: "resolveSlashHandlerForToken",
    });

    activateSlashCommands({
      account: createResolvedMattermostAccount("default"),
      commandTokens: ["valid-token"],
      registeredCommands: [createRegisteredCommand()],
      api: slashApi,
    });

    expect(resolveFromBundledLoader("valid-token")).toMatchObject({
      kind: "single",
      source: "token",
      accountIds: ["default"],
    });
  });
});
