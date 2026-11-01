import { textResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import type { AnyAgentTool, OpenClawPluginToolContext } from "../api.js";
import { VisitorAccessError } from "./errors.js";
import { VISITOR_NOTE_MAX_CHARS } from "./grant-record.js";
import { visitorRuntimeStore, type VisitorRuntime } from "./runtime.js";
import {
  visitorInviteDetailsSchema,
  visitorListDetailsSchema,
  visitorRevokeDetailsSchema,
  visitorToolErrorSchema,
} from "./tool-results.js";

const identityFields = {
  github: Type.Optional(
    Type.String({ description: "GitHub login, without @.", minLength: 1, maxLength: 39 }),
  ),
  email: Type.Optional(
    Type.String({
      description: "Email the visitor uses with Team's existing sign-in.",
      minLength: 1,
      maxLength: 254,
    }),
  ),
};

const VisitorInviteParameters = Type.Object(
  {
    ...identityFields,
    days: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 3650,
        description: "Grant duration in days; cannot be combined with forever.",
      }),
    ),
    forever: Type.Optional(
      Type.Boolean({ description: "Explicitly grant access without expiry." }),
    ),
    note: Type.Optional(
      Type.String({
        maxLength: VISITOR_NOTE_MAX_CHARS,
        description:
          "Free-text message from the inviter to the visitor, included in the invitation text; may include a session link. Replaces the stored note; omit to keep it on renewal.",
      }),
    ),
  },
  { additionalProperties: false, oneOf: [{ required: ["email"] }, { required: ["github"] }] },
);
const VisitorInviteOutputSchema = Type.Union([visitorInviteDetailsSchema, visitorToolErrorSchema]);
const VisitorRevokeParameters = Type.Object(
  {
    ...identityFields,
    profileId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    grantId: Type.Optional(Type.String({ format: "uuid" })),
  },
  { additionalProperties: false },
);
const VisitorRevokeOutputSchema = Type.Union([visitorRevokeDetailsSchema, visitorToolErrorSchema]);
const VisitorListParameters = Type.Object({}, { additionalProperties: false });
const VisitorListOutputSchema = Type.Union([visitorListDetailsSchema, visitorToolErrorSchema]);

export function createVisitorTools(context: OpenClawPluginToolContext<2>): AnyAgentTool[] {
  let runtime = visitorRuntimeStore.tryGetRuntime();
  const assertCurrent = () => {
    context.assertInvocationCurrent();
    if (context.senderIsOwner !== true) {
      throw new VisitorAccessError(
        "Only administrators and designated owners can manage visitors.",
      );
    }
  };
  const definitions = [
    {
      name: "visitor_invite",
      label: "Invite visitor",
      description:
        "Grant or renew visitor access to the Team Gateway. Requires administrator or designated-owner authority. Provide exactly one Team sign-in email or GitHub login. A GitHub invitation uses the immutable account ID, not public email. Checks restricted guest access and preserves existing assigned roles. Grants expire after the configured duration (14 days by default); forever must be explicit. An optional note from you to the visitor, such as a session link to start from, is stored with the grant; renewal without a note keeps the existing one. The result includes invitationText: short plain text naming the inviter, sign-in address, identity to use, expiry, and note, ready to hand to the visitor.",
      parameters: VisitorInviteParameters,
      outputSchema: VisitorInviteOutputSchema,
      run: async ({ service, readInviter, readSignInUrl }: VisitorRuntime, raw: unknown) =>
        service.invite(raw, {
          assertCurrent,
          invitedVia: context.sessionKey ?? context.agentId,
          invitedBy: await readInviter(),
          signInUrl: readSignInUrl(),
        }),
    },
    {
      name: "visitor_revoke",
      label: "Revoke visitor",
      description:
        "Remove the recorded Visitor invitations selected for a profileId, or cancel one invitation by grantId, including before first sign-in. Use the IDs returned by visitor_list or visitor_invite. Person selection keeps the selected identity current at local commit and before policy requests. Already committed expirations remain ended if cleanup fails. Email targets that address. GitHub login targets its immutable account and its person's recorded invitations. An explicit email or GitHub login can remove that target's unmanaged policy entry. Do not combine profileId or grantId with another selector. Preserves saved work, existing PRs and independent staff access. Already absent grants are a no-op.",
      parameters: VisitorRevokeParameters,
      outputSchema: VisitorRevokeOutputSchema,
      run: ({ service }: VisitorRuntime, raw: unknown) => service.revoke(raw, assertCurrent),
    },
    {
      name: "visitor_list",
      label: "List visitors",
      description:
        "List recorded visitor grants, current verified GitHub identities, current Gateway access, invitation and expiry dates, and drift from the Access policy. Grant expiry does not describe independent staff access. Unmanaged policy targets are reported and retained; missing policy targets are never automatically restored.",
      parameters: VisitorListParameters,
      outputSchema: VisitorListOutputSchema,
      run: ({ service }: VisitorRuntime) => service.list(assertCurrent),
    },
  ];
  return definitions.map(({ name, label, description, parameters, outputSchema, run }) => ({
    name,
    label,
    description,
    parameters,
    outputSchema,
    async execute(_id, raw) {
      // Bind once; a retained tool cannot inherit a replacement service's lifetime.
      runtime ??= visitorRuntimeStore.tryGetRuntime();
      if (!runtime) {
        return {
          ...textResult("Start the Gateway with visitor-access enabled before managing visitors.", {
            error: true,
          }),
          isError: true,
        };
      }
      try {
        assertCurrent();
        const { text, details } = await run(runtime, raw);
        return textResult(text, details);
      } catch (error) {
        return {
          ...textResult(runtime.errorText(error), { error: true }),
          isError: true,
        };
      }
    },
  }));
}
