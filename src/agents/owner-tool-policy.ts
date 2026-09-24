import { authorizeOperatorScopesForMethod } from "../gateway/method-scopes.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../security/dangerous-tools.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

/** Person-scoped sessions use RPC authorization; other owner tools keep their existing grants. */
export function resolveOwnerOnlyToolPolicy(input: {
  senderIsOwner?: boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  sessionPortalTarget?: object;
  hasAutomationGrant?: boolean;
}) {
  const authority = input.operatorAuthority;
  if (authority) {
    assertAdmittedRunOperatorAuthority(authority);
    authority.assertCurrent();
  }
  if (input.senderIsOwner !== false) {
    return undefined;
  }
  return {
    deny: GATEWAY_OWNER_ONLY_CORE_TOOLS.filter(
      (name) =>
        (name !== "sessions" ||
          !authority ||
          !authorizeOperatorScopesForMethod("sessions.groups.list", authority.scopes).allowed) &&
        (name !== "portal" || !input.sessionPortalTarget) &&
        (name !== AUTOMATIONS_TOOL_NAME || !input.hasAutomationGrant),
    ),
  };
}
