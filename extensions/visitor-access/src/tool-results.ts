import { Type, type Static } from "typebox";

const expiresAtSchema = Type.Union([Type.String(), Type.Null()], {
  description: "Null means an explicit forever grant.",
});

export const visitorInviteDetailsSchema = Type.Object(
  {
    outcome: Type.Union([Type.Literal("invited"), Type.Literal("renewed")]),
    email: Type.String(),
    grantId: Type.String(),
    githubLogin: Type.Optional(Type.String()),
    expiresAt: expiresAtSchema,
    gatewayAccess: Type.String(),
    signInUrl: Type.String(),
  },
  { additionalProperties: false },
);

export const visitorRevokeDetailsSchema = Type.Object(
  {
    outcome: Type.Union([Type.Literal("revoked"), Type.Literal("not_found")]),
    emails: Type.Array(Type.String()),
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
          email: Type.String(),
          grantId: Type.Optional(Type.String()),
          profileId: Type.Optional(Type.String()),
          githubLogin: Type.Optional(Type.String()),
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
        { additionalProperties: false },
      ),
    ),
    unmanaged: Type.Array(
      Type.Object(
        { email: Type.String(), gatewayAccess: Type.String() },
        { additionalProperties: false },
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
