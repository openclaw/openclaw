import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  SERVEPATH_BASE_URL,
  SERVEPATH_DEFAULT_API_KEY_ENV_VAR,
  SERVEPATH_DEFAULT_MODEL_ALIAS,
  SERVEPATH_DEFAULT_MODEL_ID,
  SERVEPATH_PROVIDER_ID,
  SERVEPATH_PROVIDER_LABEL,
} from "./defaults.js";
import {
  applyServepathConfig,
  applyServepathProviderConfig,
  SERVEPATH_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildServepathDynamicModel, buildServepathProvider } from "./provider-catalog.js";

export {
  applyServepathConfig,
  applyServepathProviderConfig,
  buildServepathDynamicModel,
  buildServepathProvider,
  createProviderApiKeyAuthMethod,
  SERVEPATH_BASE_URL,
  SERVEPATH_DEFAULT_API_KEY_ENV_VAR,
  SERVEPATH_DEFAULT_MODEL_ALIAS,
  SERVEPATH_DEFAULT_MODEL_ID,
  SERVEPATH_DEFAULT_MODEL_REF,
  SERVEPATH_PROVIDER_ID,
  SERVEPATH_PROVIDER_LABEL,
};
