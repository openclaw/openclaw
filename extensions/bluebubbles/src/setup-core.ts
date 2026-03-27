import {
  createZodSetupInputValidator,
  createTopLevelChannelDmPolicySetter,
  normalizeAccountId,
  patchScopedAccountConfig,
  prepareScopedSetupConfig,
  type ChannelSetupAdapter,
  type DmPolicy,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { z } from "zod";
import { applyBlueBubblesConnectionConfig } from "./config-apply.js";

const channel = "bluebubbles" as const;
const setBlueBubblesTopLevelDmPolicy = createTopLevelChannelDmPolicySetter({
  channel,
});

const BlueBubblesSetupInputSchema = z
  .object({
    httpUrl: z.string().optional(),
    password: z.string().optional(),
  })
  .passthrough();

export function setBlueBubblesDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  return setBlueBubblesTopLevelDmPolicy(cfg, dmPolicy);
}

export function setBlueBubblesAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch: { allowFrom },
    ensureChannelEnabled: false,
    ensureAccountEnabled: false,
  });
}

export const blueBubblesSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    prepareScopedSetupConfig({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: createZodSetupInputValidator({
    schema: BlueBubblesSetupInputSchema,
    validate: ({ input }) => {
      if (!input.httpUrl && !input.password) {
        return "BlueBubbles requires --http-url and --password.";
      }
      if (!input.httpUrl) {
        return "BlueBubbles requires --http-url.";
      }
      if (!input.password) {
        return "BlueBubbles requires --password.";
      }
      return null;
    },
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const next = prepareScopedSetupConfig({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
      migrateBaseName: true,
    });
    return applyBlueBubblesConnectionConfig({
      cfg: next,
      accountId,
      patch: {
        serverUrl: input.httpUrl,
        password: input.password,
        webhookPath: input.webhookPath,
      },
      onlyDefinedFields: true,
    });
  },
};
