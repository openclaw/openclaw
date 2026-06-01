import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
  DijieAuditSummarySchema,
  DijieDeviceBindRequestSchema,
  DijieExecutionGrantSchema,
  DijieExecutionTokenRequestSchema,
  DijieRolePackageManifestSchema,
} from "./schema/dijie.js";
import { ProtocolSchemas } from "./schema/protocol-schemas.js";

describe("Dijie protocol schemas", () => {
  it("validates device binding requests", () => {
    const validate = Compile(DijieDeviceBindRequestSchema);

    expect(
      validate.Check({
        deviceId: "device_local_1",
        publicKey: "pubkey",
        displayName: "MacBook",
        platform: "darwin",
        workspaceRef: "workspace_local_1",
        nonce: "nonce",
        signedAt: Date.now(),
        signature: "signature",
      }),
    ).toBe(true);

    expect(
      validate.Check({
        deviceId: "device_local_1",
        publicKey: "pubkey",
        nonce: "nonce",
        signedAt: Date.now(),
        signature: "signature",
        extra: "not allowed",
      }),
    ).toBe(false);
  });

  it("validates execution token requests without runtime pricing mutation", () => {
    const validate = Compile(DijieExecutionTokenRequestSchema);

    expect(
      validate.Check({
        roleListingId: "role_developer_agent",
        entitlementId: "ent_123",
        deviceId: "device_local_1",
        workspaceRef: "workspace_local_1",
        localGatewayId: "gateway_local_1",
        requestedBy: {
          actorId: "cus_123",
          actorType: "customer",
        },
        intent: "run authorized role package",
      }),
    ).toBe(true);

    expect(
      validate.Check({
        roleListingId: "role_developer_agent",
        entitlementId: "ent_123",
        deviceId: "device_local_1",
        workspaceRef: "workspace_local_1",
        localGatewayId: "gateway_local_1",
        requestedBy: {
          actorId: "cus_123",
          actorType: "customer",
        },
        pricing: {
          kind: "metered_runtime",
        },
      }),
    ).toBe(false);
  });

  it("validates execution grants with zero marketplace platform fee", () => {
    const validate = Compile(DijieExecutionGrantSchema);
    const grant = {
      executionId: "exec_123",
      roleListingId: "role_customer_support_agent",
      packageId: "pkg_customer_support",
      packageVersion: "1.0.0",
      developerRef: "dev_001",
      listingOwnerRef: "seller_001",
      billingBeneficiaryRef: "dev_001",
      entitlementId: "ent_123",
      deviceId: "device_local_1",
      workspaceRef: "workspace_local_1",
      localGatewayId: "gateway_local_1",
      token: "token",
      issuedAt: "2026-05-31T03:00:00.000Z",
      expiresAt: "2026-05-31T03:05:00.000Z",
      pricing: {
        kind: "one_time_authorization",
        authorizationFeeCents: 29900,
        currency: "CNY",
        platformFeeBps: 0,
        developerReceivableCents: 29900,
      },
      roleTokenPricing: {
        inputTokenCentsPerMillion: 120,
        outputTokenCentsPerMillion: 480,
        currency: "CNY",
        developerReceivableBps: 10000,
        platformFeeBps: 0,
      },
      scopes: ["role.execute", "audit.write"],
    };

    expect(validate.Check(grant)).toBe(true);
    expect(
      validate.Check({
        ...grant,
        pricing: { ...grant.pricing, platformFeeBps: 1500 },
      }),
    ).toBe(false);
    expect(
      validate.Check({
        ...grant,
        roleTokenPricing: undefined,
      }),
    ).toBe(false);
    expect(
      validate.Check({
        ...grant,
        roleTokenPricing: { ...grant.roleTokenPricing, inputTokenCentsPerMillion: -1 },
      }),
    ).toBe(false);
    expect(
      validate.Check({
        ...grant,
        roleTokenPricing: { ...grant.roleTokenPricing, currency: "" },
      }),
    ).toBe(false);
    expect(
      validate.Check({
        ...grant,
        roleTokenPricing: { ...grant.roleTokenPricing, developerReceivableBps: 8500 },
      }),
    ).toBe(false);
    expect(
      validate.Check({
        ...grant,
        roleTokenPricing: { ...grant.roleTokenPricing, platformFeeBps: 1500 },
      }),
    ).toBe(false);
  });

  it("validates role package manifests and audit summaries", () => {
    const validateManifest = Compile(DijieRolePackageManifestSchema);
    const validateAudit = Compile(DijieAuditSummarySchema);
    const roleResult = {
      executionId: "exec_123",
      roleListingId: "role_customer_support_agent",
      packageId: "pkg_customer_support",
      packageVersion: "1.0.0",
      developerRef: "dev_001",
      listingOwnerRef: "seller_001",
      billingBeneficiaryRef: "dev_001",
      status: "completed",
      startedAt: "2026-05-31T03:00:00.000Z",
      endedAt: "2026-05-31T03:03:00.000Z",
      roleTokenPricing: {
        inputTokenCentsPerMillion: 120,
        outputTokenCentsPerMillion: 480,
        currency: "CNY",
        developerReceivableBps: 10000,
        platformFeeBps: 0,
      },
      modelProxyUsage: {
        requestCount: 3,
        inputTokens: 1200,
        outputTokens: 300,
      },
      summary: "Generated a role package.",
      changedFiles: ["role_package/manifest.json"],
      artifacts: [
        {
          id: "artifact_role_package",
          type: "role_package",
          title: "role_package.zip",
          sizeBytes: 1024,
          sha256: "sha256",
        },
      ],
    };

    expect(
      validateManifest.Check({
        manifestVersion: 1,
        rolePackageId: "pkg_123",
        roleListingId: "role_customer_support_agent",
        version: "1.0.0",
        name: "客户支持岗位",
        entrypoint: "role_package/manifest.json",
        permissions: ["workspace.read", "workspace.write"],
        files: [
          {
            path: "role_package/manifest.json",
            sha256: "sha256",
            sizeBytes: 512,
          },
        ],
      }),
    ).toBe(true);

    expect(
      validateAudit.Check({
        executionId: "exec_123",
        deviceId: "device_local_1",
        workspaceRef: "workspace_local_1",
        roleListingId: "role_developer_agent",
        packageId: "pkg_customer_support",
        packageVersion: "1.0.0",
        developerRef: "dev_001",
        listingOwnerRef: "seller_001",
        billingBeneficiaryRef: "dev_001",
        entitlementId: "ent_123",
        localGatewayId: "gateway_local_1",
        status: "completed",
        startedAt: "2026-05-31T03:00:00.000Z",
        endedAt: "2026-05-31T03:03:00.000Z",
        roleTokenPricing: {
          inputTokenCentsPerMillion: 120,
          outputTokenCentsPerMillion: 480,
          currency: "CNY",
          developerReceivableBps: 10000,
          platformFeeBps: 0,
        },
        modelProxyUsage: {
          requestCount: 3,
          inputTokens: 1200,
          outputTokens: 300,
        },
        toolUsage: {
          shellCommands: 2,
          testsRun: 1,
          filesRead: 8,
          filesChanged: 1,
        },
        result: roleResult,
      }),
    ).toBe(true);
  });

  it("exports Dijie schemas through the protocol registry", () => {
    expect(ProtocolSchemas.DijieExecutionTokenRequest).toBe(DijieExecutionTokenRequestSchema);
    expect(ProtocolSchemas.DijieAuditSummary).toBe(DijieAuditSummarySchema);
  });
});
