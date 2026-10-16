/**
 * Lightweight Anthropic Vertex setup entry. It exposes provider auth detection
 * without importing the stream runtime or Vertex SDK.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAnthropicVertexConfigApiKey } from "./region.js";

export default definePluginEntry({
  id: "anthropic-vertex",
  name: "Anthropic Vertex Setup",
  description: "Lightweight Anthropic Vertex setup hooks",
  register(api) {
    api.registerProvider({
      id: "anthropic-vertex",
      label: "Anthropic Vertex",
      auth: [],
      resolveConfigApiKey: ({ env }) => resolveAnthropicVertexConfigApiKey(env),
    });
  },
});
