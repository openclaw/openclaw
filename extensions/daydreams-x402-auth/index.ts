import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

const PROVIDER_ID = "x402";
const PROVIDER_LABEL = "Daydreams Router (x402)";
const PLUGIN_ID = "daydreams-x402-auth";

const DEFAULT_ROUTER_URL = "https://ai.xgate.run";
const DEFAULT_NETWORK = "eip155:8453";
const DEFAULT_PERMIT_CAP_USD = 10;
const DEFAULT_MODEL_ID = "moonshot:kimi-k2.5";
const DEFAULT_MODEL_REF = `x402/${DEFAULT_MODEL_ID}`;
const ANTHROPIC_MODEL_ID = "anthropic:claude-opus-4-5";
const ANTHROPIC_MODEL_REF = `x402/${ANTHROPIC_MODEL_ID}`;
const DEFAULT_AUTO_REF = "x402/auto";

const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;

function normalizePrivateKey(value: string): string | null {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("0X") ? `0x${trimmed.slice(2)}` : trimmed;
  return PRIVATE_KEY_REGEX.test(normalized) ? normalized : null;
}

function normalizeRouterUrl(value: string): string {
  const raw = value.trim() || DEFAULT_ROUTER_URL;
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  // Store the bare origin — SDKs and the payment wrapper add paths as needed
  return withProtocol.replace(/\/+$/, "").replace(/\/v1\/?$/, "");
}

function normalizePermitCap(value: string): number | null {
  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeNetwork(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

const x402Plugin = {
  id: PLUGIN_ID,
  name: "Daydreams Router (x402) Auth",
  description: "Permit-signed auth for Daydreams Router (x402)",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/x402",
      auth: [
        {
          id: "wallet",
          label: "Wallet private key",
          hint: "Signs ERC-2612 permits per request",
          kind: "api_key",
          run: async (ctx) => {
            await ctx.prompter.note(
              [
                "Daydreams Router uses wallet-signed ERC-2612 permits for payment in USDC.",
                "Use a dedicated wallet for AI spend; keys are stored locally.",
              ].join("\n"),
              "x402",
            );

            const keyInput = await ctx.prompter.text({
              message: "Wallet private key (0x + 64 hex chars)",
              validate: (value) =>
                normalizePrivateKey(value) ? undefined : "Invalid private key format",
            });
            const normalizedKey = normalizePrivateKey(String(keyInput));
            if (!normalizedKey) throw new Error("Invalid private key format");

            const routerInput = await ctx.prompter.text({
              message: "Daydreams Router URL",
              initialValue: DEFAULT_ROUTER_URL,
              validate: (value) => {
                try {
                  // eslint-disable-next-line no-new
                  new URL(value);
                  return undefined;
                } catch {
                  return "Invalid URL";
                }
              },
            });
            const routerUrl = normalizeRouterUrl(String(routerInput));

            const capInput = await ctx.prompter.text({
              message: "Permit cap (USD)",
              initialValue: String(DEFAULT_PERMIT_CAP_USD),
              validate: (value) => (normalizePermitCap(value) ? undefined : "Invalid amount"),
            });
            const permitCap = normalizePermitCap(String(capInput)) ?? DEFAULT_PERMIT_CAP_USD;

            const networkInput = await ctx.prompter.text({
              message: "Network (CAIP-2)",
              initialValue: DEFAULT_NETWORK,
              validate: (value) => (normalizeNetwork(value) ? undefined : "Required"),
            });
            const network = normalizeNetwork(String(networkInput)) ?? DEFAULT_NETWORK;

            const existingPluginConfig =
              ctx.config.plugins?.entries?.[PLUGIN_ID]?.config &&
              typeof ctx.config.plugins.entries[PLUGIN_ID]?.config === "object"
                ? (ctx.config.plugins.entries[PLUGIN_ID]?.config as Record<string, unknown>)
                : {};

            const pluginConfigPatch: Record<string, unknown> = { ...existingPluginConfig };
            if (existingPluginConfig.permitCap === undefined) {
              pluginConfigPatch.permitCap = permitCap;
            }
            if (!existingPluginConfig.network) {
              pluginConfigPatch.network = network;
            }

            return {
              profiles: [
                {
                  profileId: "x402:default",
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: normalizedKey,
                  },
                },
              ],
              configPatch: {
                plugins: {
                  entries: {
                    [PLUGIN_ID]: {
                      config: pluginConfigPatch,
                    },
                  },
                },
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: routerUrl,
                      apiKey: "x402-wallet",
                      api: "anthropic-messages",
                      authHeader: false,
                      models: [
                        {
                          id: DEFAULT_MODEL_ID,
                          name: "Moonshot Kimi K2.5",
                          api: "openai-completions",
                          reasoning: false,
                          input: ["text", "image"],
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          contextWindow: 262144,
                          maxTokens: 8192,
                        },
                        {
                          id: ANTHROPIC_MODEL_ID,
                          name: "Anthropic Opus 4.5",
                          reasoning: false,
                          input: ["text", "image"],
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          contextWindow: 200000,
                          maxTokens: 8192,
                        },
                      ],
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: {
                      [DEFAULT_AUTO_REF]: {},
                      [DEFAULT_MODEL_REF]: { alias: "Kimi" },
                      [ANTHROPIC_MODEL_REF]: { alias: "Opus" },
                    },
                  },
                },
              },
              defaultModel: DEFAULT_AUTO_REF,
              notes: [
                `Daydreams Router base URL set to ${routerUrl}.`,
                "Permit caps apply per signed session; update plugins.entries.daydreams-x402-auth.config to change.",
              ],
            };
          },
        },
      ],
    });
  },
};

export default x402Plugin;
