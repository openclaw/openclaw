import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.js";
import { resolveSecretRefValues } from "../../../src/secrets/resolve.js";
import {
  applyResolvedAssignments,
  createResolverContext,
} from "../../../src/secrets/runtime-shared.js";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

describe("googlechat secret contract", () => {
  it("resolves account serviceAccount SecretRefs for enabled accounts", async () => {
    const sourceConfig: OpenClawConfig = {
      channels: {
        googlechat: {
          enabled: true,
          accounts: {
            work: {
              enabled: true,
              serviceAccountRef: {
                source: "env",
                provider: "default",
                id: "GOOGLECHAT_SERVICE_ACCOUNT",
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        GOOGLECHAT_SERVICE_ACCOUNT: '{"client_email":"bot@example.com"}',
      },
    });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      defaults: undefined,
      context,
    });

    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      {
        config: sourceConfig,
        env: context.env,
        cache: context.cache,
      },
    );
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });

    const workAccount = resolvedConfig.channels?.googlechat?.accounts?.work;
    expect((workAccount as any)?.serviceAccount).toBe('{"client_email":"bot@example.com"}');
    expect(context.warnings).toEqual([]);
  });
});
