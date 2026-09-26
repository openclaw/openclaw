import { Type } from "typebox";
import type { AnyAgentTool, OpenClawPluginToolContext } from "../api.js";
import { VisitorAccessError } from "./errors.js";
import { visitorRuntimeStore } from "./runtime.js";
import type { VisitorAccessService } from "./visitors.js";

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
        "Grant or renew visitor access to team.openclaw.ai. Requires administrator or designated-owner authority. Provide the Team sign-in email or a GitHub login with a matching public email. Checks restricted guest access and preserves existing assigned roles. Grants expire after the configured duration (14 days by default); forever must be explicit.",
      parameters: Type.Object(
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
        },
        { additionalProperties: false },
      ),
      run: (service: VisitorAccessService, raw: unknown) =>
        service.invite(raw, { assertCurrent, invitedVia: context.sessionKey ?? context.agentId }),
    },
    {
      name: "visitor_revoke",
      label: "Revoke visitor",
      description:
        "Remove visitor access by email or GitHub login. GitHub login removes all recorded grants for that login. Explicit email can also remove an unmanaged policy entry. Already absent grants are a no-op.",
      parameters: Type.Object(identityFields, { additionalProperties: false }),
      run: (service: VisitorAccessService, raw: unknown) => service.revoke(raw, assertCurrent),
    },
    {
      name: "visitor_list",
      label: "List visitors",
      description:
        "List recorded visitor grants, current Gateway access, invitation and expiry dates, and drift from the Access policy. Grant expiry does not describe independent staff access. Unmanaged policy emails are reported and retained; missing policy emails are never automatically restored.",
      parameters: Type.Object({}, { additionalProperties: false }),
      run: (service: VisitorAccessService) => service.list(assertCurrent),
    },
  ];
  return definitions.map(({ name, label, description, parameters, run }) => ({
    name,
    label,
    description,
    parameters,
    async execute(_id, raw) {
      // Bind once; a retained tool cannot inherit a replacement service's lifetime.
      runtime ??= visitorRuntimeStore.tryGetRuntime();
      if (!runtime) {
        return {
          content: [
            {
              type: "text",
              text: "Start the Gateway with visitor-access enabled before managing visitors.",
            },
          ],
          details: { error: true },
          isError: true,
        };
      }
      try {
        assertCurrent();
        return { content: [{ type: "text", text: await run(runtime.service, raw) }], details: {} };
      } catch (error) {
        return {
          content: [{ type: "text", text: runtime.errorText(error) }],
          details: { error: true },
          isError: true,
        };
      }
    },
  }));
}
