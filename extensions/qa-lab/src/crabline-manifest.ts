// Qa Lab plugin module builds Crabline manifests for selected channel providers.
import type { ManifestDefinition } from "crabline";

export const QA_CRABLINE_USER_NAME = "openclaw-qa";

export type QaCrablineManifestSchema = {
  parse(input: unknown): ManifestDefinition;
};

export function createQaCrablineFixtureId(channel: string) {
  return `qa-crabline-${channel}`;
}

export function parseQaCrablineManifest(
  schema: QaCrablineManifestSchema,
  input: unknown,
): ManifestDefinition {
  return schema.parse(input);
}

export function createQaCrablineCatalogManifestInput() {
  return {
    configVersion: 1,
    fixtures: [],
    providers: {},
    userName: QA_CRABLINE_USER_NAME,
  };
}

export function createQaCrablineManifestInput(channel: string): {
  fixtureId: string;
  manifest: unknown;
} {
  const fixtureId = createQaCrablineFixtureId(channel);
  const manifest = {
    configVersion: 1,
    fixtures: [
      {
        id: fixtureId,
        inboundMatch: {
          author: "assistant",
          nonce: "ignore",
          strategy: "contains",
        },
        mode: "agent",
        provider: channel,
        target: {
          id: `${channel}-default`,
        },
        timeoutMs: 5_000,
      },
    ],
    providers: {
      [channel]: {
        adapter: channel,
        platform: channel,
      },
    },
    userName: QA_CRABLINE_USER_NAME,
  };

  return { fixtureId, manifest };
}
