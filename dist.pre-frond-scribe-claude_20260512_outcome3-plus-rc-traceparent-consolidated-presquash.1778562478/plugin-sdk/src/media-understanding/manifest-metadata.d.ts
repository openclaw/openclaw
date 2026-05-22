import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingProvider } from "./types.js";
export declare function buildMediaUnderstandingManifestMetadataRegistry(cfg?: OpenClawConfig, workspaceDir?: string): Map<string, MediaUnderstandingProvider>;
