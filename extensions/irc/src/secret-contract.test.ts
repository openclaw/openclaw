// Irc tests cover the secret contract plugin behavior.
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { resolveIrcAccount } from "./accounts.js";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";
import type { CoreConfig } from "./types.js";

const nickServRef = { source: "env", provider: "default", id: "NS_PW" } as const;

async function resolveIrcSecretAssignments(sourceConfig: CoreConfig, env: Record<string, string>) {
  const resolvedConfig: CoreConfig = structuredClone(sourceConfig);
  const context = createResolverContext({ sourceConfig, env });

  collectRuntimeConfigAssignments({
    config: resolvedConfig,
    defaults: sourceConfig.secrets?.defaults,
    context,
  });

  const resolved = await resolveSecretRefValues(
    context.assignments.map((assignment) => assignment.ref),
    { config: sourceConfig, env: context.env, cache: context.cache },
  );
  applyResolvedAssignments({ assignments: context.assignments, resolved });

  return {
    config: resolvedConfig,
    assignments: context.assignments,
    warnings: context.warnings,
  };
}

describe("irc secret contract", () => {
  it("resolves a top-level nickserv password ref for an account with a service-only nickserv block", async () => {
    const resolved = await resolveIrcSecretAssignments(
      {
        channels: {
          irc: {
            nickserv: { password: nickServRef },
            accounts: {
              work: {
                host: "irc.example.com",
                nick: "clawwork",
                nickserv: { service: "NickServ" },
              },
            },
          },
        },
      } as CoreConfig,
      { NS_PW: "hunter2" },
    );

    expect(resolved.config.channels?.irc?.nickserv?.password).toBe("hunter2");
    expect(resolved.assignments).toMatchObject([{ path: "channels.irc.nickserv.password" }]);
    expect(resolved.warnings).toStrictEqual([]);
    // The account resolution merges nickserv field by field, so the inherited password is what
    // NickServ IDENTIFY actually uses.
    expect(
      resolveIrcAccount({ cfg: resolved.config, accountId: "work" }).config.nickserv?.password,
    ).toBe("hunter2");
  });

  it("keeps the top-level nickserv password ref inactive for an account that owns nickserv.password", async () => {
    const resolved = await resolveIrcSecretAssignments(
      {
        channels: {
          irc: {
            nickserv: { password: nickServRef },
            accounts: {
              work: {
                host: "irc.example.com",
                nick: "clawwork",
                nickserv: { password: "account-plaintext" },
              },
            },
          },
        },
      } as CoreConfig,
      { NS_PW: "hunter2" },
    );

    expect(resolved.config.channels?.irc?.nickserv?.password).toEqual(nickServRef);
    expect(resolved.warnings).toEqual([
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.irc.nickserv.password",
      }),
    ]);
  });

  it("resolves an account nickserv password ref for that account", async () => {
    const resolved = await resolveIrcSecretAssignments(
      {
        channels: {
          irc: {
            accounts: {
              work: {
                host: "irc.example.com",
                nick: "clawwork",
                nickserv: { service: "NickServ", password: nickServRef },
              },
            },
          },
        },
      } as CoreConfig,
      { NS_PW: "hunter2" },
    );

    expect(resolved.config.channels?.irc?.accounts?.work?.nickserv?.password).toBe("hunter2");
    expect(resolved.warnings).toStrictEqual([]);
  });

  it("keeps the top-level nickserv password ref inactive when an account inherits enabled: false", async () => {
    const resolved = await resolveIrcSecretAssignments(
      {
        channels: {
          irc: {
            nickserv: { enabled: false, password: nickServRef },
            accounts: {
              work: {
                host: "irc.example.com",
                nick: "clawwork",
                nickserv: { service: "NickServ" },
              },
            },
          },
        },
      } as CoreConfig,
      { NS_PW: "hunter2" },
    );

    expect(resolved.config.channels?.irc?.nickserv?.password).toEqual(nickServRef);
    expect(resolved.assignments).toStrictEqual([]);
  });
});
