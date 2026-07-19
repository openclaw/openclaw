import type { CliBackendConfig } from "../../config/types.js";
import type { ImageContent } from "../../llm/types.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import "./cli-images.js";

type LoadPromptRefImagesParams = {
  prompt: string;
  workspaceDir: string;
  maxBytes?: number;
  workspaceOnly?: boolean;
  sandbox?: { root: string; bridge: SandboxFsBridge };
};

type WriteCliImagesParams = {
  backend: CliBackendConfig;
  workspaceDir: string;
  images: ImageContent[];
  maxBytes?: number;
};

type CliImagesTestApi = {
  loadPromptRefImages(params: LoadPromptRefImagesParams): Promise<ImageContent[]>;
  writeCliImages(
    params: WriteCliImagesParams,
  ): Promise<{ paths: string[]; cleanup: () => Promise<void> }>;
};

function getTestApi(): CliImagesTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cliImagesTestApi")
  ] as CliImagesTestApi;
}

export async function loadPromptRefImages(
  params: LoadPromptRefImagesParams,
): Promise<ImageContent[]> {
  return getTestApi().loadPromptRefImages(params);
}

export async function writeCliImages(
  params: WriteCliImagesParams,
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  return getTestApi().writeCliImages(params);
}
