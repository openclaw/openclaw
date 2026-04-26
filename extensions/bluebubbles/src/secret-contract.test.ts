import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.js";
import { resolveSecretRefValues } from "../../../src/secrets/resolve.js";
import {
  applyResolvedAssignments,
  createResolverContext,
} from "../../../src/secrets/runtime-shared.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });
type SecretContractSourceConfig = Omit<OpenClawConfig, "channels"> & {
  channels?: Record<string, unknown>;
};

async function resolveConfig<T extends SecretContractSourceConfig>(
  sourceConfig: T,
  env: NodeJS.ProcessEnv,
) {
  const resolvedConfig = structuredClone(sourceConfig);
  const configForResolver = sourceConfig as OpenClawConfig;
  const context = createResolverContext({ sourceConfig: configForResolver, env });
  collectRuntimeConfigAssignments({ config: resolvedConfig, defaults: undefined, context });
  const resolved = await resolveSecretRefValues(
    context.assignments.map((assignment) => assignment.ref),
    { config: configForResolver, env: context.env, cache: context.cache },
  );
  applyResolvedAssignments({ assignments: context.assignments, resolved });
  return { resolvedConfig, context };
}

describe("bluebubbles secret contract", () => {
  it("registers handle allowlist SecretRef targets", () => {
    expect(
      secretTargetRegistryEntries
        .map((entry) => entry.pathPattern)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual([
      "channels.bluebubbles.accounts.*.allowFrom[]",
      "channels.bluebubbles.accounts.*.groupAllowFrom[]",
      "channels.bluebubbles.accounts.*.password",
      "channels.bluebubbles.allowFrom[]",
      "channels.bluebubbles.groupAllowFrom[]",
      "channels.bluebubbles.password",
    ]);
  });

  it("resolves top-level and account allowlist SecretRefs", async () => {
    const sourceConfig = {
      channels: {
        bluebubbles: {
          enabled: true,
          allowFrom: [envRef("BLUEBUBBLES_OWNER")],
          groupAllowFrom: ["${BLUEBUBBLES_GROUP_OWNER}"],
          accounts: {
            work: {
              enabled: true,
              allowFrom: [envRef("BLUEBUBBLES_WORK_OWNER")],
              groupAllowFrom: [envRef("BLUEBUBBLES_WORK_GROUP_OWNER")],
            },
            inherited: {
              enabled: true,
            },
          },
        },
      },
    } satisfies SecretContractSourceConfig;

    const { resolvedConfig, context } = await resolveConfig(sourceConfig, {
      BLUEBUBBLES_OWNER: "+15550003001",
      BLUEBUBBLES_GROUP_OWNER: "chat_id:chat-1",
      BLUEBUBBLES_WORK_OWNER: "user@example.com",
      BLUEBUBBLES_WORK_GROUP_OWNER: "chat_id:chat-2",
    });

    const bluebubbles = resolvedConfig.channels?.bluebubbles;
    expect(bluebubbles?.allowFrom).toEqual(["+15550003001"]);
    expect(bluebubbles?.groupAllowFrom).toEqual(["chat_id:chat-1"]);
    expect(bluebubbles?.accounts?.work?.allowFrom).toEqual(["user@example.com"]);
    expect(bluebubbles?.accounts?.work?.groupAllowFrom).toEqual(["chat_id:chat-2"]);
    expect(context.warnings).toEqual([]);
  });
});
