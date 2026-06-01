import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const TimestampSchema = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);

export const DijieOneTimeAuthorizationPricingSchema = Type.Object(
  {
    kind: Type.Literal("one_time_authorization"),
    authorizationFeeCents: Type.Integer({ minimum: 0 }),
    currency: NonEmptyString,
    platformFeeBps: Type.Literal(0),
    developerReceivableCents: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const DijieRoleTokenPricingSchema = Type.Object(
  {
    inputTokenCentsPerMillion: Type.Integer({ minimum: 0 }),
    outputTokenCentsPerMillion: Type.Integer({ minimum: 0 }),
    currency: NonEmptyString,
    developerReceivableBps: Type.Literal(10000),
    platformFeeBps: Type.Literal(0),
  },
  { additionalProperties: false },
);

export const DijieModelProxyUsageSchema = Type.Object(
  {
    requestCount: Type.Integer({ minimum: 0 }),
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const DijieDeviceBindRequestSchema = Type.Object(
  {
    deviceId: NonEmptyString,
    publicKey: NonEmptyString,
    displayName: Type.Optional(NonEmptyString),
    platform: Type.Optional(NonEmptyString),
    workspaceRef: Type.Optional(NonEmptyString),
    nonce: NonEmptyString,
    signedAt: Type.Integer({ minimum: 0 }),
    signature: NonEmptyString,
  },
  { additionalProperties: false },
);

export const DijieDeviceBindResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    deviceId: NonEmptyString,
    cloudActorId: Type.Optional(NonEmptyString),
    deviceToken: Type.Optional(NonEmptyString),
    expiresAt: Type.Optional(TimestampSchema),
    error: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const DijieExecutionTokenRequestSchema = Type.Object(
  {
    roleListingId: NonEmptyString,
    entitlementId: NonEmptyString,
    deviceId: NonEmptyString,
    workspaceRef: NonEmptyString,
    localGatewayId: NonEmptyString,
    requestedBy: Type.Object(
      {
        actorId: NonEmptyString,
        actorType: Type.Union([
          Type.Literal("customer"),
          Type.Literal("member"),
          Type.Literal("admin"),
        ]),
      },
      { additionalProperties: false },
    ),
    intent: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const DijieExecutionGrantSchema = Type.Object(
  {
    executionId: NonEmptyString,
    roleListingId: NonEmptyString,
    packageId: NonEmptyString,
    packageVersion: NonEmptyString,
    developerRef: NonEmptyString,
    listingOwnerRef: NonEmptyString,
    billingBeneficiaryRef: NonEmptyString,
    entitlementId: NonEmptyString,
    deviceId: NonEmptyString,
    workspaceRef: NonEmptyString,
    localGatewayId: NonEmptyString,
    token: NonEmptyString,
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    pricing: DijieOneTimeAuthorizationPricingSchema,
    roleTokenPricing: DijieRoleTokenPricingSchema,
    scopes: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const DijieExecutionTokenResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    grant: Type.Optional(DijieExecutionGrantSchema),
    error: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const DijieRolePackageManifestSchema = Type.Object(
  {
    manifestVersion: Type.Literal(1),
    rolePackageId: NonEmptyString,
    roleListingId: NonEmptyString,
    version: NonEmptyString,
    name: NonEmptyString,
    entrypoint: NonEmptyString,
    permissions: Type.Array(NonEmptyString),
    files: Type.Array(
      Type.Object(
        {
          path: NonEmptyString,
          sha256: NonEmptyString,
          sizeBytes: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const DijieRoleResultSchema = Type.Object(
  {
    executionId: NonEmptyString,
    roleListingId: NonEmptyString,
    packageId: NonEmptyString,
    packageVersion: NonEmptyString,
    developerRef: NonEmptyString,
    listingOwnerRef: NonEmptyString,
    billingBeneficiaryRef: NonEmptyString,
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("timed_out"),
    ]),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
    roleTokenPricing: DijieRoleTokenPricingSchema,
    modelProxyUsage: DijieModelProxyUsageSchema,
    summary: Type.Optional(Type.String()),
    changedFiles: Type.Array(NonEmptyString),
    artifacts: Type.Array(
      Type.Object(
        {
          id: NonEmptyString,
          type: NonEmptyString,
          title: NonEmptyString,
          sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
          sha256: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const DijieAuditSummarySchema = Type.Object(
  {
    executionId: NonEmptyString,
    deviceId: NonEmptyString,
    workspaceRef: NonEmptyString,
    roleListingId: NonEmptyString,
    packageId: NonEmptyString,
    packageVersion: NonEmptyString,
    developerRef: NonEmptyString,
    listingOwnerRef: NonEmptyString,
    billingBeneficiaryRef: NonEmptyString,
    entitlementId: NonEmptyString,
    localGatewayId: NonEmptyString,
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("timed_out"),
    ]),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
    roleTokenPricing: DijieRoleTokenPricingSchema,
    modelProxyUsage: DijieModelProxyUsageSchema,
    toolUsage: Type.Object(
      {
        shellCommands: Type.Integer({ minimum: 0 }),
        testsRun: Type.Integer({ minimum: 0 }),
        filesRead: Type.Integer({ minimum: 0 }),
        filesChanged: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    result: DijieRoleResultSchema,
  },
  { additionalProperties: false },
);
