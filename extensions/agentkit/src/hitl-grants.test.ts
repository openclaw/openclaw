import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentkitPluginConfig } from "./config.js";
import {
  applyAgentkitHitlGrant,
  findMatchingAgentkitHitlGrant,
  saveAgentkitHitlGrant,
} from "./hitl-grants.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const bashScope = {
  toolName: "bash",
  sessionKey: "agent:main:test",
  agentId: "main",
};

async function createPluginConfig(hitlOverrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentkit-hitl-grants-"));
  tempDirs.push(dir);
  return resolveAgentkitPluginConfig({
    hitl: {
      enabled: true,
      resourceUrl: "http://127.0.0.1:4126/protected",
      protectedTools: ["bash"],
      grantsFile: path.join(dir, "grants.json"),
      ...hitlOverrides,
    },
  });
}

describe("agentkit HITL grants", () => {
  it("matches and consumes allow-once grants", async () => {
    const pluginConfig = await createPluginConfig();
    saveAgentkitHitlGrant({
      pluginConfig,
      grant: {
        id: "grant-1",
        approvalMode: "delegation",
        resourceUrl: "http://127.0.0.1:4126/protected",
        decision: "allow-once",
        scope: bashScope,
        humanLookupMode: "local-trust-verified-signer",
        signerAddress: "0xabc",
        proofNullifier: null,
        grantedAtMs: 10,
        expiresAtMs: null,
        consumedAtMs: null,
      },
    });

    const applied = applyAgentkitHitlGrant({
      pluginConfig,
      scope: bashScope,
      nowMs: 20,
    });

    expect(applied?.grant.id).toBe("grant-1");
    expect(applied?.consumed).toBe(true);
    expect(
      findMatchingAgentkitHitlGrant({
        pluginConfig,
        scope: bashScope,
        nowMs: 21,
      }),
    ).toBeNull();
  });

  it("keeps allow-always grants available until expiry", async () => {
    const pluginConfig = await createPluginConfig();
    saveAgentkitHitlGrant({
      pluginConfig,
      grant: {
        id: "grant-2",
        approvalMode: "delegation",
        resourceUrl: "http://127.0.0.1:4126/protected",
        decision: "allow-always",
        scope: bashScope,
        humanLookupMode: "agentbook",
        signerAddress: "0xdef",
        proofNullifier: null,
        grantedAtMs: 10,
        expiresAtMs: 100,
        consumedAtMs: null,
      },
    });

    const applied = applyAgentkitHitlGrant({
      pluginConfig,
      scope: bashScope,
      nowMs: 20,
    });

    expect(applied?.grant.id).toBe("grant-2");
    expect(applied?.consumed).toBe(false);
    expect(
      findMatchingAgentkitHitlGrant({
        pluginConfig,
        scope: bashScope,
        nowMs: 21,
      })?.id,
    ).toBe("grant-2");
    expect(
      findMatchingAgentkitHitlGrant({
        pluginConfig,
        scope: bashScope,
        nowMs: 101,
      }),
    ).toBeNull();
  });

  it("does not reuse grants for a different protected resource", async () => {
    const pluginConfig = await createPluginConfig();
    const changedResourceConfig = resolveAgentkitPluginConfig({
      hitl: {
        enabled: true,
        resourceUrl: "http://127.0.0.1:4999/protected",
        protectedTools: ["bash"],
        grantsFile: pluginConfig.hitl.grantsFile,
      },
    });
    saveAgentkitHitlGrant({
      pluginConfig,
      grant: {
        id: "grant-resource",
        approvalMode: "delegation",
        resourceUrl: "http://127.0.0.1:4126/protected",
        decision: "allow-always",
        scope: bashScope,
        humanLookupMode: "agentbook",
        signerAddress: "0xdef",
        proofNullifier: null,
        grantedAtMs: 10,
        expiresAtMs: 100,
        consumedAtMs: null,
      },
    });

    expect(
      findMatchingAgentkitHitlGrant({
        pluginConfig: changedResourceConfig,
        scope: bashScope,
        nowMs: 20,
      }),
    ).toBeNull();
    expect(
      applyAgentkitHitlGrant({
        pluginConfig: changedResourceConfig,
        scope: bashScope,
        nowMs: 20,
      }),
    ).toBeNull();
    expect(
      findMatchingAgentkitHitlGrant({
        pluginConfig,
        scope: bashScope,
        nowMs: 21,
      })?.id,
    ).toBe("grant-resource");
  });

  it("does not reuse human approval grants in delegation mode", async () => {
    const humanApprovalConfig = await createPluginConfig({
      mode: "human-approval",
      resourceUrl: null,
    });
    const delegationConfig = resolveAgentkitPluginConfig({
      hitl: {
        enabled: true,
        mode: "delegation",
        resourceUrl: "http://127.0.0.1:4126/protected",
        protectedTools: ["bash"],
        grantsFile: humanApprovalConfig.hitl.grantsFile,
      },
    });
    saveAgentkitHitlGrant({
      pluginConfig: humanApprovalConfig,
      grant: {
        id: "grant-human",
        approvalMode: "human-approval",
        resourceUrl: null,
        decision: "allow-always",
        scope: bashScope,
        humanLookupMode: "world-id",
        signerAddress: null,
        proofNullifier: "nullifier-1",
        grantedAtMs: 10,
        expiresAtMs: 100,
        consumedAtMs: null,
      },
    });

    expect(
      applyAgentkitHitlGrant({
        pluginConfig: delegationConfig,
        scope: bashScope,
        nowMs: 20,
      }),
    ).toBeNull();
    expect(
      findMatchingAgentkitHitlGrant({
        pluginConfig: humanApprovalConfig,
        scope: bashScope,
        nowMs: 21,
      })?.id,
    ).toBe("grant-human");
  });

  it("does not reuse delegation grants in human approval mode", async () => {
    const delegationConfig = await createPluginConfig();
    const humanApprovalConfig = resolveAgentkitPluginConfig({
      hitl: {
        enabled: true,
        mode: "human-approval",
        resourceUrl: null,
        protectedTools: ["bash"],
        grantsFile: delegationConfig.hitl.grantsFile,
      },
    });
    saveAgentkitHitlGrant({
      pluginConfig: delegationConfig,
      grant: {
        id: "grant-delegation",
        approvalMode: "delegation",
        resourceUrl: "http://127.0.0.1:4126/protected",
        decision: "allow-always",
        scope: bashScope,
        humanLookupMode: "agentbook",
        signerAddress: "0xdef",
        proofNullifier: null,
        grantedAtMs: 10,
        expiresAtMs: 100,
        consumedAtMs: null,
      },
    });

    expect(
      applyAgentkitHitlGrant({
        pluginConfig: humanApprovalConfig,
        scope: bashScope,
        nowMs: 20,
      }),
    ).toBeNull();
    expect(
      findMatchingAgentkitHitlGrant({
        pluginConfig: delegationConfig,
        scope: bashScope,
        nowMs: 21,
      })?.id,
    ).toBe("grant-delegation");
  });
});
