import {
  buildChannelConfigSchema,
  refineChannelDmPolicy,
} from "openclaw/plugin-sdk/channel-config-schema";
import { isHttpsUrlAllowedByHostnameSuffixAllowlist } from "openclaw/plugin-sdk/ssrf-policy";
import { z } from "zod";
import { MSTeamsConfigSchemaBase } from "../config-schema-api.js";
import { isAllowedBotFrameworkServiceUrl } from "./bot-framework-service-url.js";
import { msTeamsChannelConfigUiHints } from "./config-ui-hints.js";

function isAzureChinaBotFrameworkServiceUrl(value: string): boolean {
  return isHttpsUrlAllowedByHostnameSuffixAllowlist(value.trim(), ["botframework.azure.cn"]);
}

export const MSTeamsConfigSchema = MSTeamsConfigSchemaBase.extend({
  serviceUrl: MSTeamsConfigSchemaBase.shape.serviceUrl
    .unwrap()
    .refine(isAllowedBotFrameworkServiceUrl, {
      message:
        "channels.msteams.serviceUrl must use a supported Microsoft Teams Bot Connector host",
    })
    .optional(),
}).superRefine((value, ctx) => {
  refineChannelDmPolicy({ channelId: "msteams", value, ctx });
  if (value.sso?.enabled === true && !value.sso.connectionName?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sso", "connectionName"],
      message:
        "channels.msteams.sso.enabled=true requires channels.msteams.sso.connectionName to identify the Bot Framework OAuth connection",
    });
  }
  if (
    value.cloud &&
    value.cloud !== "Public" &&
    value.cloud !== "China" &&
    !value.serviceUrl?.trim()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["serviceUrl"],
      message:
        "channels.msteams.cloud requires channels.msteams.serviceUrl for non-public Teams clouds",
    });
  }
  if (
    value.cloud === "China" &&
    value.serviceUrl?.trim() &&
    !isAzureChinaBotFrameworkServiceUrl(value.serviceUrl)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["serviceUrl"],
      message:
        "channels.msteams.cloud=China requires channels.msteams.serviceUrl to use an Azure China Bot Framework channel host",
    });
  }
  if (
    value.cloud !== "China" &&
    value.serviceUrl?.trim() &&
    isAzureChinaBotFrameworkServiceUrl(value.serviceUrl)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cloud"],
      message: "Azure China Bot Framework serviceUrl hosts require channels.msteams.cloud=China",
    });
  }

  // Federated auth fields (appId, tenantId, certificatePath,
  // useManagedIdentity) may come from MSTEAMS_* environment variables,
  // so we cannot require them in the config object itself.
  // Runtime validation happens in resolveMSTeamsCredentials().
});

export const MSTeamsChannelConfigSchema = buildChannelConfigSchema(MSTeamsConfigSchema, {
  uiHints: msTeamsChannelConfigUiHints,
});
