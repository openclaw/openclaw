import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { runTinyFishFetch } from "./src/tinyfish-client.js";

export type FetchTinyFishContentParams = {
  url: string;
  extractMode: "markdown" | "text";
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
  maxChars?: number;
};

export type FetchTinyFishContentResult = {
  text: string;
  title?: string;
  finalUrl?: string;
};

export async function fetchTinyFishContent(
  params: FetchTinyFishContentParams,
): Promise<FetchTinyFishContentResult> {
  const cfg: OpenClawConfig = {
    plugins: {
      entries: {
        tinyfish: {
          enabled: true,
          config: {
            webFetch: {
              apiKey: params.apiKey,
              baseUrl: params.baseUrl,
            },
          },
        },
      },
    },
  };

  const result = await runTinyFishFetch({
    cfg,
    url: params.url,
    extractMode: params.extractMode,
    maxChars: params.maxChars,
    timeoutSeconds: params.timeoutSeconds,
  });

  return {
    text: typeof result.text === "string" ? result.text : "",
    title: readStringValue(result.title),
    finalUrl: readStringValue(result.finalUrl),
  };
}
