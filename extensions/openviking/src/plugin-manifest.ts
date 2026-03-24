import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import OPENVIKING_MANIFEST_JSON from "../openclaw.plugin.json" with { type: "json" };

type OpenVikingPluginManifest = {
  id: string;
  kind: "context-engine";
  name: string;
  description: string;
  uiHints?: OpenClawPluginConfigSchema["uiHints"];
  configSchema: OpenClawPluginConfigSchema["jsonSchema"];
};

export const openVikingPluginManifest = OPENVIKING_MANIFEST_JSON as OpenVikingPluginManifest;

export const openVikingPluginConfigSchema: OpenClawPluginConfigSchema = {
  uiHints: openVikingPluginManifest.uiHints ?? {},
  jsonSchema: openVikingPluginManifest.configSchema,
};
