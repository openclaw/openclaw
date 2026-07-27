import { createRequire } from "node:module";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { hasConfiguredSlackChannelState } from "./configured-state.js";

type SlackStateCase = {
  label: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  configured: boolean;
};

describe("Slack lightweight configured-state", () => {
  it("declares the Slack owner as its identity-aware configured-state checker", () => {
    const manifest = createRequire(import.meta.url)("./package.json") as {
      openclaw: { channel: { configuredState: unknown } };
    };

    expect(manifest.openclaw.channel.configuredState).toEqual({
      specifier: "./configured-state",
      exportName: "hasConfiguredSlackChannelState",
    });
  });

  it.each<SlackStateCase>([
    {
      label: "default socket-mode bot identity with its app and bot tokens",
      cfg: {},
      env: { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test" },
      configured: true,
    },
    {
      label: "a user token without explicit user identity",
      cfg: {},
      env: { SLACK_APP_TOKEN: "xapp-test", SLACK_USER_TOKEN: "xoxp-test" },
      configured: false,
    },
    {
      label: "explicit user identity with its app and user tokens",
      cfg: { channels: { slack: { postAs: "user" } } },
      env: { SLACK_APP_TOKEN: "xapp-test", SLACK_USER_TOKEN: "xoxp-test" },
      configured: true,
    },
    {
      label: "a retired identity alias without the canonical user postAs",
      cfg: { channels: { slack: { identity: "user" } } },
      env: { SLACK_APP_TOKEN: "xapp-test", SLACK_USER_TOKEN: "xoxp-test" },
      configured: false,
    },
    {
      label: "explicit user identity without its required user token",
      cfg: { channels: { slack: { postAs: "user" } } },
      env: { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test" },
      configured: false,
    },
    {
      label: "an app token without an identity token",
      cfg: {},
      env: { SLACK_APP_TOKEN: "xapp-test" },
      configured: false,
    },
    {
      label: "a bot token without its socket-mode app token",
      cfg: {},
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      configured: false,
    },
    {
      label: "a whitespace-only app token",
      cfg: {},
      env: { SLACK_APP_TOKEN: "   ", SLACK_BOT_TOKEN: "xoxb-test" },
      configured: false,
    },
    {
      label: "configured socket-mode bot credentials",
      cfg: {
        channels: { slack: { appToken: "xapp-test", botToken: "xoxb-test" } },
      },
      env: {},
      configured: true,
    },
    {
      label: "configured socket-mode user credentials",
      cfg: {
        channels: {
          slack: { postAs: "user", appToken: "xapp-test", userToken: "xoxp-test" },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "an HTTP bot identity with its signing secret",
      cfg: {
        channels: { slack: { mode: "http", signingSecret: "signing-secret" } },
      },
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      configured: true,
    },
    {
      label: "an HTTP bot identity without its signing secret",
      cfg: { channels: { slack: { mode: "http" } } },
      env: { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test" },
      configured: false,
    },
    {
      label: "an HTTP user identity with its signing secret",
      cfg: {
        channels: {
          slack: { mode: "http", postAs: "user", signingSecret: "signing-secret" },
        },
      },
      env: { SLACK_USER_TOKEN: "xoxp-test" },
      configured: true,
    },
    {
      label: "an HTTP user identity without its signing secret",
      cfg: { channels: { slack: { mode: "http", postAs: "user" } } },
      env: { SLACK_APP_TOKEN: "xapp-test", SLACK_USER_TOKEN: "xoxp-test" },
      configured: false,
    },
    {
      label: "a relay bot identity with its complete relay transport",
      cfg: {
        channels: {
          slack: {
            mode: "relay",
            relay: {
              url: "https://relay.example.com",
              authToken: "relay-token",
              gatewayId: "relay-gateway",
            },
          },
        },
      },
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      configured: true,
    },
    {
      label: "a relay bot identity without relay authentication",
      cfg: {
        channels: {
          slack: {
            mode: "relay",
            relay: { url: "https://relay.example.com", gatewayId: "relay-gateway" },
          },
        },
      },
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      configured: false,
    },
    {
      label: "a relay user identity without the required companion bot token",
      cfg: {
        channels: {
          slack: {
            mode: "relay",
            postAs: "user",
            relay: {
              url: "https://relay.example.com",
              authToken: "relay-token",
              gatewayId: "relay-gateway",
            },
          },
        },
      },
      env: { SLACK_USER_TOKEN: "xoxp-test" },
      configured: false,
    },
    {
      label: "a relay user identity with its user and companion bot tokens",
      cfg: {
        channels: {
          slack: {
            mode: "relay",
            postAs: "user",
            relay: {
              url: "https://relay.example.com",
              authToken: "relay-token",
              gatewayId: "relay-gateway",
            },
          },
        },
      },
      env: { SLACK_USER_TOKEN: "xoxp-test", SLACK_BOT_TOKEN: "xoxb-test" },
      configured: true,
    },
    {
      label: "configured credential references",
      cfg: {
        channels: {
          slack: {
            appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
            botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named socket-mode bot account",
      cfg: {
        channels: {
          slack: {
            accounts: {
              work: { appToken: "xapp-work", botToken: "xoxb-work" },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named socket-mode user account",
      cfg: {
        channels: {
          slack: {
            accounts: {
              work: { postAs: "user", appToken: "xapp-work", userToken: "xoxp-work" },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named account using only the retired identity alias",
      cfg: {
        channels: {
          slack: {
            accounts: {
              work: { identity: "user", appToken: "xapp-work", userToken: "xoxp-work" },
            },
          },
        },
      },
      env: {},
      configured: false,
    },
    {
      label: "a named bot account inheriting its root app token",
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-shared",
            accounts: { work: { botToken: "xoxb-work" } },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named account inheriting explicit user identity",
      cfg: {
        channels: {
          slack: {
            postAs: "user",
            appToken: "xapp-shared",
            accounts: { work: { userToken: "xoxp-work" } },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named HTTP account with its inherited signing secret",
      cfg: {
        channels: {
          slack: {
            mode: "http",
            signingSecret: "signing-secret",
            accounts: { work: { botToken: "xoxb-work" } },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named relay account with merged relay configuration",
      cfg: {
        channels: {
          slack: {
            mode: "relay",
            relay: { url: "https://relay.example.com", gatewayId: "relay-gateway" },
            accounts: {
              work: { botToken: "xoxb-work", relay: { authToken: "relay-token" } },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named relay user account with its own user and companion bot tokens",
      cfg: {
        channels: {
          slack: {
            mode: "relay",
            relay: { url: "https://relay.example.com", gatewayId: "relay-gateway" },
            accounts: {
              work: {
                postAs: "user",
                userToken: "xoxp-work",
                botToken: "xoxb-work",
                relay: { authToken: "relay-token" },
              },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named relay user account that cannot borrow a default bot token",
      cfg: {
        channels: {
          slack: {
            mode: "relay",
            relay: { url: "https://relay.example.com", gatewayId: "relay-gateway" },
            accounts: {
              work: {
                postAs: "user",
                userToken: "xoxp-work",
                relay: { authToken: "relay-token" },
              },
            },
          },
        },
      },
      env: { SLACK_BOT_TOKEN: "xoxb-default" },
      configured: false,
    },
    {
      label: "a named account that cannot inherit default-only ambient tokens",
      cfg: {
        channels: { slack: { accounts: { work: {} } } },
      },
      env: { SLACK_APP_TOKEN: "xapp-test", SLACK_USER_TOKEN: "xoxp-test" },
      configured: false,
    },
    {
      label: "a disabled named account",
      cfg: {
        channels: {
          slack: {
            accounts: {
              work: { enabled: false, appToken: "xapp-work", botToken: "xoxb-work" },
            },
          },
        },
      },
      env: {},
      configured: false,
    },
    {
      label: "an explicitly mapped default account using default-only ambient tokens",
      cfg: {
        channels: { slack: { accounts: { default: {} } } },
      },
      env: { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test" },
      configured: true,
    },
    {
      label: "a disabled default account with ambient socket credentials",
      cfg: { channels: { slack: { accounts: { default: { enabled: false } } } } },
      env: { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test" },
      configured: false,
    },
    {
      label: "a disabled default account with root socket credentials",
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-test",
            botToken: "xoxb-test",
            accounts: { default: { enabled: false } },
          },
        },
      },
      env: {},
      configured: false,
    },
    {
      label: "an active named account beside an explicitly disabled default",
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-shared",
            accounts: {
              default: { enabled: false },
              work: { botToken: "xoxb-work" },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a disabled Slack channel with complete ambient credentials",
      cfg: { channels: { slack: { enabled: false } } },
      env: { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test" },
      configured: false,
    },
    {
      label: "an explicit default HTTP override without its required signing secret",
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-root",
            botToken: "xoxb-root",
            accounts: { default: { mode: "http" } },
          },
        },
      },
      env: {},
      configured: false,
    },
    {
      label: "an explicit default HTTP override with its signing secret",
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-root",
            botToken: "xoxb-root",
            accounts: { default: { mode: "http", signingSecret: "signing-secret" } },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "an explicit default that clears its inherited bot credential",
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-root",
            botToken: "xoxb-root",
            accounts: { default: { botToken: "" } },
          },
        },
      },
      env: {},
      configured: false,
    },
    {
      label: "an enabled named account beside an invalid explicitly merged default",
      cfg: {
        channels: {
          slack: {
            appToken: "xapp-root",
            botToken: "xoxb-root",
            accounts: {
              default: { mode: "http" },
              work: { botToken: "xoxb-work" },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
  ])("recognizes $label", ({ cfg, env, configured }) => {
    expect(hasConfiguredSlackChannelState({ cfg, env })).toBe(configured);
  });
});
