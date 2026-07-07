import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";

export type PodmanPluginConfig = {
  command: string;
  connection?: string;
  url?: string;
};

export type PodmanPluginConfigInput = {
  command?: unknown;
  connection?: unknown;
  url?: unknown;
};

export function createPodmanPluginConfigSchema() {
  return buildJsonPluginConfigSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string", minLength: 1 },
      connection: { type: "string", minLength: 1 },
      url: { type: "string", minLength: 1 },
    },
  });
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolvePodmanPluginConfig(input: unknown): PodmanPluginConfig {
  const config = (input && typeof input === "object" ? input : {}) as PodmanPluginConfigInput;
  const command = readOptionalString(config.command) ?? "podman";
  const connection = readOptionalString(config.connection);
  const url = readOptionalString(config.url);
  if (connection && url) {
    throw new Error("Podman sandbox config cannot set both connection and url.");
  }
  return {
    command,
    ...(connection ? { connection } : {}),
    ...(url ? { url } : {}),
  };
}
