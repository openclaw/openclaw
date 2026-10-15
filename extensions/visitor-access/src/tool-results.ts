import { Type, type Static } from "typebox";

const expiresAtSchema = Type.Union([Type.String(), Type.Null()], {
  description: "Null means an explicit forever grant.",
});

export const visitorInviteDetailsSchema = Type.Object(
  {
    outcome: Type.Union([Type.Literal("invited"), Type.Literal("renewed")]),
    grantId: Type.String(),
    email: Type.Optional(Type.String()),
    githubAccountId: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    githubLogin: Type.Optional(Type.String()),
    expiresAt: expiresAtSchema,
    gatewayAccess: Type.String(),
    signInUrl: Type.String(),
  },
  {
    additionalProperties: false,
    oneOf: [{ required: ["email"] }, { required: ["githubAccountId"] }],
  },
);

export const visitorRevokeDetailsSchema = Type.Object(
  {
    outcome: Type.Union([Type.Literal("revoked"), Type.Literal("not_found")]),
    emails: Type.Array(Type.String()),
    githubAccountIds: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    ),
    githubLogin: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const visitorListDetailsSchema = Type.Object(
  {
    counts: Type.Object(
      {
        recorded: Type.Integer(),
        inPolicy: Type.Integer(),
        unmanaged: Type.Integer(),
        missingFromPolicy: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    grants: Type.Array(
      Type.Object(
        {
          email: Type.Optional(
            Type.String({ description: "Grant selector; pass this email to visitor_revoke." }),
          ),
          githubAccountId: Type.Optional(
            Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          ),
          grantId: Type.Optional(
            Type.String({ description: "Stable selector for canceling this invitation." }),
          ),
          profileId: Type.Optional(Type.String({ description: "Person ID for visitor_revoke." })),
          githubLogin: Type.Optional(
            Type.String({
              description:
                "Current verified GitHub identity selected by the Gateway profile, when available. Use grantId to cancel one invitation; GitHub input selects its immutable account and the person's recorded grants.",
            }),
          ),
          invitedAt: Type.String(),
          expiresAt: expiresAtSchema,
          state: Type.Union(
            [Type.Literal("managed"), Type.Literal("expired"), Type.Literal("missing_from_policy")],
            {
              description:
                "Missing policy membership takes precedence; expired grants await provider cleanup.",
            },
          ),
          gatewayAccess: Type.String(),
        },
        {
          additionalProperties: false,
          oneOf: [{ required: ["email"] }, { required: ["githubAccountId"] }],
        },
      ),
    ),
    unmanaged: Type.Array(
      Type.Object(
        {
          email: Type.Optional(Type.String()),
          githubAccountId: Type.Optional(
            Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          ),
          gatewayAccess: Type.String(),
        },
        {
          additionalProperties: false,
          oneOf: [{ required: ["email"] }, { required: ["githubAccountId"] }],
        },
      ),
    ),
    omitted: Type.Integer({ description: "Rows omitted by the text output limits." }),
  },
  { additionalProperties: false },
);

export const visitorToolErrorSchema = Type.Object(
  { error: Type.Literal(true) },
  { additionalProperties: false },
);

export type VisitorInviteDetails = Static<typeof visitorInviteDetailsSchema>;
export type VisitorRevokeDetails = Static<typeof visitorRevokeDetailsSchema>;
export type VisitorListDetails = Static<typeof visitorListDetailsSchema>;
