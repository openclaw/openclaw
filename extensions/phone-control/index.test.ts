import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/phone-control";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import registerPhoneControl from "./index.js";

function createApi(params: {
  stateDir: string;
  getConfig: () => Record<string, unknown>;
  writeConfig: (next: Record<string, unknown>) => Promise<void>;
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
}): OpenClawPluginApi {
  return {
    id: "phone-control",
    name: "phone-control",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: {
      state: {
        resolveStateDir: () => params.stateDir,
      },
      config: {
        loadConfig: () => params.getConfig(),
        writeConfigFile: (next: Record<string, unknown>) => params.writeConfig(next),
      },
    } as OpenClawPluginApi["runtime"],
    logger: { info() {}, warn() {}, error() {} },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerContextEngine() {},
    registerCommand: params.registerCommand,
    resolvePath(input: string) {
      return input;
    },
    on() {},
  };
}

function createCommandContext(args: string): PluginCommandContext {
  return {
    channel: "test",
    isAuthorizedSender: true,
    commandBody: `/phone ${args}`,
    args,
    config: {},
  };
}

describe("phone-control plugin", () => {
  it("arms sms.send as part of the writes group", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-phone-control-test-"));
    try {
      let config: Record<string, unknown> = {
        gateway: {
          nodes: {
            allowCommands: [],
            denyCommands: ["calendar.add", "contacts.add", "reminders.add", "sms.send"],
          },
        },
      };
      const writeConfigFile = vi.fn(async (next: Record<string, unknown>) => {
        config = next;
      });

      let command: OpenClawPluginCommandDefinition | undefined;
      registerPhoneControl(
        createApi({
          stateDir,
          getConfig: () => config,
          writeConfig: writeConfigFile,
          registerCommand: (nextCommand) => {
            command = nextCommand;
          },
        }),
      );

      expect(command?.name).toBe("phone");

      const res = await command?.handler(createCommandContext("arm writes 30s"));
      const text = String(res?.text ?? "");
      const nodes = (
        config.gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
      ).nodes;

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      expect(nodes?.allowCommands).toEqual([
        "calendar.add",
        "contacts.add",
        "reminders.add",
        "sms.send",
      ]);
      expect(nodes?.denyCommands).toEqual([]);
      expect(text).toContain("sms.send");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
