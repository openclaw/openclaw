import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { LEMONADE_DEFAULT_API_KEY, LEMONADE_PROVIDER_ID } from "./discovery-shared.js";
import { LEMONADE_DEFAULT_BASE_URL } from "./defaults.js";

export interface LemonadeSetupResult {
  credential: string;
  config: {
    models: {
      providers: {
        [LEMONADE_PROVIDER_ID]: {
          baseUrl: string;
          models: [];
        };
      };
    };
  };
}

export async function promptAndConfigureLemonade(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<LemonadeSetupResult> {
  const apiKey = await params.prompter.text({
    message: "Lemonade API key (optional, press Enter to skip)",
    defaultValue: "",
  });

  const credential = apiKey.trim() || LEMONADE_DEFAULT_API_KEY;

  return {
    credential,
    config: {
      models: {
        providers: {
          [LEMONADE_PROVIDER_ID]: {
            baseUrl: LEMONADE_DEFAULT_BASE_URL,
            models: [],
          },
        },
      },
    },
  };
}
