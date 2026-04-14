import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyYandexConfig, YANDEX_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildYandexProvider } from "./provider-catalog.js";

const PROVIDER_ID = "yandex";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Yandex Provider",
  description: "Bundled Yandex AI Studio provider plugin (YandexGPT)",
  provider: {
    label: "Yandex",
    docsPath: "/providers/yandex",
    auth: [
      {
        methodId: "api-key",
        label: "Yandex AI Studio API key",
        hint: "API key from Yandex AI Studio",
        optionKey: "yandexApiKey",
        flagName: "--yandex-api-key",
        envVar: "YANDEX_API_KEY",
        promptMessage: "Enter Yandex AI Studio API key",
        defaultModel: YANDEX_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyYandexConfig(cfg),
        wizard: {
          choiceId: "yandex-api-key",
          choiceLabel: "Yandex AI Studio API key",
          groupId: "yandex",
          groupLabel: "Yandex",
          groupHint: "YandexGPT and other models via AI Studio",
        },
      },
      {
        methodId: "folder-id",
        label: "Yandex Cloud folder ID",
        hint: "Folder ID (required for model URIs)",
        optionKey: "yandexFolderId",
        flagName: "--yandex-folder-id",
        envVar: "YANDEX_FOLDER_ID",
        promptMessage: "Enter Yandex Cloud folder ID",
        defaultModel: YANDEX_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyYandexConfig(cfg),
        wizard: {
          choiceId: "yandex-folder-id",
          choiceLabel: "Yandex Cloud folder ID",
          groupId: "yandex",
          groupLabel: "Yandex",
          groupHint: "Required to construct model URIs (gpt://<folder_ID>/...)",
        },
      },
    ],
    catalog: {
      buildProvider: buildYandexProvider,
    },
  },
});
