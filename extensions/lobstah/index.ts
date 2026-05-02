import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildLobstahProvider,
  LOBSTAH_DEFAULT_API_KEY_ENV_VAR,
  LOBSTAH_DEFAULT_BASE_URL,
  LOBSTAH_DEFAULT_TRACKER_URL,
  LOBSTAH_DEFAULT_WORKER_PORT,
  LOBSTAH_MODEL_PLACEHOLDER,
  LOBSTAH_PROVIDER_LABEL,
} from "./api.js";

const PROVIDER_ID = "lobstah";

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/provider-setup");
}

const INTRO_NOTE = [
  "Lobstah is a peer-to-peer compute grid.",
  "",
  "By default your machine stays invisible — nothing is announced anywhere",
  "and you don't pull any peers from the network. We'll first connect openclaw",
  "to your local lobstah-router, then ask separately about (1) discovering",
  "compute providers, and (2) advertising your machine. Both default to no.",
].join("\n");

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Lobstah Provider",
  description:
    "Distributed P2P LLM inference grid for Apple Mac mini. Routes requests to peer workers via signed-receipt federated ledger.",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: LOBSTAH_PROVIDER_LABEL,
      docsPath: "/providers/lobstah",
      envVars: [LOBSTAH_DEFAULT_API_KEY_ENV_VAR],
      auth: [
        {
          id: "custom",
          label: LOBSTAH_PROVIDER_LABEL,
          hint: "Federated P2P inference across Mac mini workers",
          kind: "custom",
          run: async (ctx) => {
            const providerSetup = await loadProviderSetup();

            await ctx.prompter.note(INTRO_NOTE, "Lobstah grid");

            const result =
              await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
                cfg: ctx.config,
                prompter: ctx.prompter,
                providerId: PROVIDER_ID,
                providerLabel: LOBSTAH_PROVIDER_LABEL,
                defaultBaseUrl: LOBSTAH_DEFAULT_BASE_URL,
                defaultApiKeyEnvVar: LOBSTAH_DEFAULT_API_KEY_ENV_VAR,
                modelPlaceholder: LOBSTAH_MODEL_PLACEHOLDER,
              });

            // Opt-in: discover compute providers from a public tracker.
            const wantsSync = await ctx.prompter.confirm({
              message: "Discover compute providers from a public lobstah tracker?",
              initialValue: false,
            });
            if (wantsSync) {
              const trackerUrl = await ctx.prompter.text({
                message: "Tracker URL to sync from",
                initialValue: LOBSTAH_DEFAULT_TRACKER_URL,
                placeholder: LOBSTAH_DEFAULT_TRACKER_URL,
              });
              await ctx.prompter.note(
                [
                  "To pull the peer list now (and any time after), run:",
                  "",
                  `  lobstah peers sync ${trackerUrl}`,
                  "",
                  "This is opt-in and revocable: peers expire from your local cache",
                  "when their TTL ends, and you can `lobstah peers remove <pubkey>`",
                  "any time.",
                ].join("\n"),
                "Sync peers",
              );
            }

            // Opt-in: advertise this machine on a public tracker.
            const wantsAdvertise = await ctx.prompter.confirm({
              message: "Advertise this machine on a public tracker so others can use your compute?",
              initialValue: false,
            });
            if (wantsAdvertise) {
              const advertiseTracker = await ctx.prompter.text({
                message: "Tracker URL to announce on",
                initialValue: LOBSTAH_DEFAULT_TRACKER_URL,
                placeholder: LOBSTAH_DEFAULT_TRACKER_URL,
              });
              const advertiseUrl = await ctx.prompter.text({
                message: "Reachable URL of your worker (peers will connect here)",
                placeholder: `http://your-public-host:${LOBSTAH_DEFAULT_WORKER_PORT}`,
                validate: (v) => (v.trim().length === 0 ? "URL is required" : undefined),
              });
              await ctx.prompter.note(
                [
                  "To start advertising, run:",
                  "",
                  `  lobstah worker start --announce-to ${advertiseTracker} \\`,
                  `      --announce-url ${advertiseUrl}`,
                  "",
                  "Stop the worker process to immediately unannounce. The tracker",
                  "entry also expires automatically after 5 minutes if heartbeats",
                  "stop. You can revoke at any time.",
                ].join("\n"),
                "Advertise compute",
              );
            }

            return result;
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: LOBSTAH_PROVIDER_LABEL,
              defaultBaseUrl: LOBSTAH_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: LOBSTAH_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: LOBSTAH_MODEL_PLACEHOLDER,
            });
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildLobstahProvider,
          });
        },
      },
      wizard: {
        setup: {
          choiceId: "lobstah",
          choiceLabel: "Lobstah grid",
          choiceHint: "Federated P2P inference",
          groupId: "lobstah",
          groupLabel: "Lobstah",
          groupHint: "Distributed compute grid (the lobster way)",
          methodId: "custom",
        },
        modelPicker: {
          label: "Lobstah grid",
          hint: "Point at a running lobstah-router (default http://127.0.0.1:17475/v1)",
          methodId: "custom",
        },
      },
      buildUnknownModelHint: () =>
        "Lobstah requires a running lobstah-router. " +
        "Start one with `lobstah router start` and run `openclaw configure`. " +
        "See: https://docs.openclaw.ai/providers/lobstah",
    });
  },
});
