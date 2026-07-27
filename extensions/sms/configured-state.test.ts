import { createRequire } from "node:module";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { hasConfiguredSmsChannelState } from "./configured-state.js";

type SmsStateCase = {
  label: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  configured: boolean;
};

const requiredPhoneEnv = {
  TWILIO_ACCOUNT_SID: "AC-test",
  TWILIO_AUTH_TOKEN: "twilio-test-token",
  TWILIO_PHONE_NUMBER: "+15550001111",
};

describe("SMS lightweight configured-state", () => {
  it("declares the SMS owner as its outbound-ready configured-state checker", () => {
    const manifest = createRequire(import.meta.url)("./package.json") as {
      openclaw: { channel: { configuredState: unknown } };
    };

    expect(manifest.openclaw.channel.configuredState).toEqual({
      specifier: "./configured-state",
      exportName: "hasConfiguredSmsChannelState",
    });
  });

  it.each<SmsStateCase>([
    {
      label: "a signed phone-number account",
      cfg: {},
      env: {
        ...requiredPhoneEnv,
        SMS_PUBLIC_WEBHOOK_URL: "https://sms.example.com/webhook",
      },
      configured: true,
    },
    {
      label: "a signed legacy sender-number account",
      cfg: {},
      env: {
        TWILIO_ACCOUNT_SID: "AC-test",
        TWILIO_AUTH_TOKEN: "twilio-test-token",
        TWILIO_SMS_FROM: "+15550001111",
        SMS_PUBLIC_WEBHOOK_URL: "https://sms.example.com/webhook",
      },
      configured: true,
    },
    {
      label: "a signed messaging-service account",
      cfg: {},
      env: {
        TWILIO_ACCOUNT_SID: "AC-test",
        TWILIO_AUTH_TOKEN: "twilio-test-token",
        TWILIO_MESSAGING_SERVICE_SID: "MG-test",
        SMS_PUBLIC_WEBHOOK_URL: "https://sms.example.com/webhook",
      },
      configured: true,
    },
    {
      label: "the existing explicit local-only signature-validation opt-out",
      cfg: {},
      env: {
        ...requiredPhoneEnv,
        SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION: "true",
      },
      configured: true,
    },
    {
      label: "an outbound phone-number account without an inbound webhook or opt-out",
      cfg: {},
      env: requiredPhoneEnv,
      configured: true,
    },
    {
      label: "an explicitly false signature-validation opt-out",
      cfg: {},
      env: {
        ...requiredPhoneEnv,
        SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION: "false",
      },
      configured: true,
    },
    {
      label: "a whitespace-padded signature-validation opt-out",
      cfg: {},
      env: {
        ...requiredPhoneEnv,
        SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION: " true ",
      },
      configured: true,
    },
    {
      label: "an incorrectly capitalized signature-validation opt-out",
      cfg: {},
      env: {
        ...requiredPhoneEnv,
        SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION: "TRUE",
      },
      configured: true,
    },
    {
      label: "a whitespace-only public webhook URL",
      cfg: {},
      env: { ...requiredPhoneEnv, SMS_PUBLIC_WEBHOOK_URL: "   " },
      configured: true,
    },
    {
      label: "an opt-out without an account SID",
      cfg: {},
      env: {
        TWILIO_AUTH_TOKEN: "twilio-test-token",
        TWILIO_PHONE_NUMBER: "+15550001111",
        SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION: "true",
      },
      configured: false,
    },
    {
      label: "an opt-out without an auth token",
      cfg: {},
      env: {
        TWILIO_ACCOUNT_SID: "AC-test",
        TWILIO_PHONE_NUMBER: "+15550001111",
        SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION: "true",
      },
      configured: false,
    },
    {
      label: "an opt-out without any supported sender",
      cfg: {},
      env: {
        TWILIO_ACCOUNT_SID: "AC-test",
        TWILIO_AUTH_TOKEN: "twilio-test-token",
        SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION: "true",
      },
      configured: false,
    },
    {
      label: "explicit configured signed credentials",
      cfg: {
        channels: {
          sms: {
            accountSid: "AC-test",
            authToken: "twilio-test-token",
            fromNumber: "+15550001111",
            publicWebhookUrl: "https://sms.example.com/webhook",
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "an outbound account with signature validation securely enabled by default",
      cfg: {
        channels: {
          sms: {
            accountSid: "AC-test",
            authToken: "twilio-test-token",
            fromNumber: "+15550001111",
            dangerouslyDisableSignatureValidation: false,
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "an explicitly configured boolean local-only signature opt-out",
      cfg: {
        channels: {
          sms: {
            accountSid: "AC-test",
            authToken: "twilio-test-token",
            fromNumber: "+15550001111",
            dangerouslyDisableSignatureValidation: true,
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a configured auth-token reference",
      cfg: {
        channels: {
          sms: {
            accountSid: "AC-test",
            authToken: { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" },
            fromNumber: "+15550001111",
            publicWebhookUrl: "https://sms.example.com/webhook",
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "an explicitly blank root account SID shadows ambient Twilio credentials",
      cfg: { channels: { sms: { accountSid: " ", authToken: "root-token" } } },
      env: requiredPhoneEnv,
      configured: false,
    },
    {
      label: "an explicitly blank root auth token shadows ambient Twilio credentials",
      cfg: { channels: { sms: { authToken: " " } } },
      env: requiredPhoneEnv,
      configured: false,
    },
    {
      label: "an explicitly blank root phone sender shadows both ambient phone senders",
      cfg: { channels: { sms: { fromNumber: " " } } },
      env: { ...requiredPhoneEnv, TWILIO_SMS_FROM: "+15550002222" },
      configured: false,
    },
    {
      label: "an explicitly blank root messaging sender shadows its ambient sender",
      cfg: { channels: { sms: { messagingServiceSid: " " } } },
      env: {
        TWILIO_ACCOUNT_SID: "AC-test",
        TWILIO_AUTH_TOKEN: "twilio-test-token",
        TWILIO_MESSAGING_SERVICE_SID: "MG-test",
      },
      configured: false,
    },
    {
      label: "the legacy phone sender after a blank primary environment sender",
      cfg: {},
      env: {
        TWILIO_ACCOUNT_SID: "AC-test",
        TWILIO_AUTH_TOKEN: "twilio-test-token",
        TWILIO_PHONE_NUMBER: " ",
        TWILIO_SMS_FROM: "+15550002222",
      },
      configured: true,
    },
    {
      label: "a configured messaging sender beside an explicitly cleared phone sender",
      cfg: { channels: { sms: { fromNumber: "", messagingServiceSid: "MG-configured" } } },
      env: requiredPhoneEnv,
      configured: true,
    },
    {
      label: "a configured phone sender beside an explicitly cleared messaging sender",
      cfg: {
        channels: {
          sms: { fromNumber: "+15550003333", messagingServiceSid: "" },
        },
      },
      env: {
        TWILIO_ACCOUNT_SID: "AC-test",
        TWILIO_AUTH_TOKEN: "twilio-test-token",
        TWILIO_MESSAGING_SERVICE_SID: "MG-env",
      },
      configured: true,
    },
    {
      label: "a configured auth-token reference takes precedence over ambient credentials",
      cfg: {
        channels: {
          sms: {
            authToken: { source: "env", provider: "default", id: "OWNER_SMS_AUTH_TOKEN" },
          },
        },
      },
      env: requiredPhoneEnv,
      configured: true,
    },
    {
      label: "a signed named account",
      cfg: {
        channels: {
          sms: {
            accounts: {
              work: {
                accountSid: "AC-work",
                authToken: "work-token",
                fromNumber: "+15550002222",
                publicWebhookUrl: "https://sms.example.com/work",
              },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named account inheriting a signed root webhook",
      cfg: {
        channels: {
          sms: {
            publicWebhookUrl: "https://sms.example.com/work",
            accounts: {
              work: {
                accountSid: "AC-work",
                authToken: "work-token",
                fromNumber: "+15550002222",
              },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named account with its explicitly configured local-only opt-out",
      cfg: {
        channels: {
          sms: {
            accounts: {
              work: {
                accountSid: "AC-work",
                authToken: "work-token",
                fromNumber: "+15550002222",
                dangerouslyDisableSignatureValidation: true,
              },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "an outbound named account without an inbound webhook or opt-out",
      cfg: {
        channels: {
          sms: {
            accounts: {
              work: {
                accountSid: "AC-work",
                authToken: "work-token",
                fromNumber: "+15550002222",
              },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named account that cannot borrow default-only environment credentials",
      cfg: {
        channels: {
          sms: {
            accounts: {
              work: {
                accountSid: "AC-work",
                fromNumber: "+15550002222",
                publicWebhookUrl: "https://sms.example.com/work",
              },
            },
          },
        },
      },
      env: { TWILIO_AUTH_TOKEN: "default-only-token" },
      configured: false,
    },
    {
      label: "a complete named outbound account ignores a default-only signature opt-out",
      cfg: {
        channels: {
          sms: {
            accounts: {
              work: {
                accountSid: "AC-work",
                authToken: "work-token",
                fromNumber: "+15550002222",
              },
            },
          },
        },
      },
      env: { SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION: "true" },
      configured: true,
    },
    {
      label: "a disabled named account",
      cfg: {
        channels: {
          sms: {
            accounts: {
              work: {
                enabled: false,
                accountSid: "AC-work",
                authToken: "work-token",
                fromNumber: "+15550002222",
                publicWebhookUrl: "https://sms.example.com/work",
              },
            },
          },
        },
      },
      env: {},
      configured: false,
    },
    {
      label: "a disabled default account with ambient Twilio credentials",
      cfg: { channels: { sms: { accounts: { default: { enabled: false } } } } },
      env: requiredPhoneEnv,
      configured: false,
    },
    {
      label: "a disabled default account with root Twilio credentials",
      cfg: {
        channels: {
          sms: {
            accountSid: "AC-test",
            authToken: "twilio-test-token",
            fromNumber: "+15550001111",
            accounts: { default: { enabled: false } },
          },
        },
      },
      env: {},
      configured: false,
    },
    {
      label: "an active named SMS account beside an explicitly disabled default",
      cfg: {
        channels: {
          sms: {
            accounts: {
              default: { enabled: false },
              work: {
                accountSid: "AC-work",
                authToken: "work-token",
                fromNumber: "+15550002222",
              },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a disabled SMS channel with complete ambient credentials",
      cfg: { channels: { sms: { enabled: false } } },
      env: requiredPhoneEnv,
      configured: false,
    },
    {
      label: "an explicit default that clears its inherited Twilio auth token",
      cfg: {
        channels: {
          sms: {
            accountSid: "AC-root",
            authToken: "root-token",
            fromNumber: "+15550001111",
            accounts: { default: { authToken: "" } },
          },
        },
      },
      env: {},
      configured: false,
    },
    {
      label: "an explicit default blank account SID shadows ambient credentials",
      cfg: { channels: { sms: { accounts: { default: { accountSid: " " } } } } },
      env: requiredPhoneEnv,
      configured: false,
    },
    {
      label: "an explicit default blank auth token shadows ambient credentials",
      cfg: { channels: { sms: { accounts: { default: { authToken: " " } } } } },
      env: requiredPhoneEnv,
      configured: false,
    },
    {
      label: "an explicit default blank phone sender shadows ambient phone senders",
      cfg: { channels: { sms: { accounts: { default: { fromNumber: " " } } } } },
      env: { ...requiredPhoneEnv, TWILIO_SMS_FROM: "+15550002222" },
      configured: false,
    },
    {
      label: "an explicit default blank messaging sender shadows its ambient sender",
      cfg: { channels: { sms: { accounts: { default: { messagingServiceSid: " " } } } } },
      env: {
        TWILIO_ACCOUNT_SID: "AC-test",
        TWILIO_AUTH_TOKEN: "twilio-test-token",
        TWILIO_MESSAGING_SERVICE_SID: "MG-test",
      },
      configured: false,
    },
    {
      label: "an explicit default blank auth token overrides an inherited SecretRef",
      cfg: {
        channels: {
          sms: {
            authToken: { source: "env", provider: "default", id: "OWNER_SMS_AUTH_TOKEN" },
            accounts: { default: { authToken: "" } },
          },
        },
      },
      env: requiredPhoneEnv,
      configured: false,
    },
    {
      label: "an explicit default SecretRef overrides a cleared root auth token",
      cfg: {
        channels: {
          sms: {
            authToken: "",
            accounts: {
              default: {
                authToken: { source: "env", provider: "default", id: "OWNER_SMS_AUTH_TOKEN" },
              },
            },
          },
        },
      },
      env: requiredPhoneEnv,
      configured: true,
    },
    {
      label: "an explicit default that clears its inherited Twilio sender",
      cfg: {
        channels: {
          sms: {
            accountSid: "AC-root",
            authToken: "root-token",
            fromNumber: "+15550001111",
            accounts: { default: { fromNumber: "" } },
          },
        },
      },
      env: {},
      configured: false,
    },
    {
      label: "an enabled named account beside an invalid explicitly merged SMS default",
      cfg: {
        channels: {
          sms: {
            accountSid: "AC-root",
            authToken: "root-token",
            fromNumber: "+15550001111",
            accounts: {
              default: { authToken: "" },
              work: { authToken: "work-token" },
            },
          },
        },
      },
      env: {},
      configured: true,
    },
    {
      label: "a named blank auth override cannot borrow ambient credentials",
      cfg: {
        channels: {
          sms: {
            authToken: { source: "env", provider: "default", id: "OWNER_SMS_AUTH_TOKEN" },
            accounts: {
              default: { enabled: false },
              work: { accountSid: "AC-work", authToken: "", fromNumber: "+15550002222" },
            },
          },
        },
      },
      env: requiredPhoneEnv,
      configured: false,
    },
    {
      label: "a named SecretRef overrides a cleared inherited auth token",
      cfg: {
        channels: {
          sms: {
            authToken: "",
            accounts: {
              default: { enabled: false },
              work: {
                accountSid: "AC-work",
                authToken: { source: "env", provider: "default", id: "OWNER_SMS_AUTH_TOKEN" },
                fromNumber: "+15550002222",
              },
            },
          },
        },
      },
      env: requiredPhoneEnv,
      configured: true,
    },
  ])("recognizes $label", ({ cfg, env, configured }) => {
    expect(hasConfiguredSmsChannelState({ cfg, env })).toBe(configured);
  });
});
