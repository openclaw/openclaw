import type { CliBackendConfig } from "../../config/types.js";
import type { ImageContent } from "../../llm/types.js";
import "./cli-images.js";

type WriteCliImagesParams = {
  backend: CliBackendConfig;
  workspaceDir: string;
  images: ImageContent[];
  maxBytes?: number;
};

type CliImagesTestApi = {
  writeCliImages(
    params: WriteCliImagesParams,
  ): Promise<{ paths: string[]; cleanup: () => Promise<void> }>;
};

function getTestApi(): CliImagesTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cliImagesTestApi")
  ] as CliImagesTestApi;
}

export async function writeCliImages(
  params: WriteCliImagesParams,
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  return getTestApi().writeCliImages(params);
}
