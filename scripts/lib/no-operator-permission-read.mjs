import {
  BOUNDARY_GUARD_FIXTURE_ROOT,
  isSkippedTypeAssertionTestPath,
  pathMatchesTypeAssertionRoot,
} from "./type-assertion-guard-scope.mjs";

// Live reads of an operator's role, role policy and profile access. A run admits once and then
// keeps the frozen facts on its admitted operator authority (AGENTS.md "Choose good compromises").
const READERS = new Set([
  "authorizeCurrentOperatorRoleScopes",
  "captureResidentUserProfileAccess",
  "onOperatorRolePolicyChanged",
  "resolveOperatorRolePolicy",
  "resolveOperatorRolePolicyForAssignment",
  "resolveOperatorRolePolicyForProfile",
  "resolveOperatorRoleSelection",
]);

// Owners and work starts that may read live permissions. Shrink only: a new file takes its
// scopes, role and policy from the admitted operator authority instead of joining this list.
export const ADMISSION_FILES = new Set([
  "src/commands/doctor/cron/execution-context-check.ts",
  "src/flows/doctor-member-roles.store.ts",
  "src/gateway/agent-turn/agent-session-persist.ts",
  "src/gateway/assistant-media-policy.ts",
  "src/gateway/channel-operator-authority.ts",
  "src/gateway/control-ui-session-pr-read.ts",
  "src/gateway/factory-github-proof.ts",
  "src/gateway/github-publication-inspect-reader.ts",
  "src/gateway/github-publication-requester.ts",
  "src/gateway/http-auth-user-profile.ts",
  "src/gateway/human-mention-policy.ts",
  "src/gateway/ios-approval-push-authority.ts",
  "src/gateway/openclaw-id/member-profiles.ts",
  "src/gateway/openclaw-id/member-role-change.ts",
  "src/gateway/operator-access-policy.ts",
  "src/gateway/operator-admission.ts",
  "src/gateway/operator-model-presentation.ts",
  "src/gateway/operator-role-policy.ts",
  "src/gateway/operator-run-authority.ts",
  "src/gateway/project-access.ts",
  "src/gateway/question-session-access.ts",
  "src/gateway/remote-control-ui-ingress.ts",
  "src/gateway/repository-integration-identity.ts",
  "src/gateway/server-chat-metadata-lifecycle.ts",
  "src/gateway/server-methods/agents.ts",
  "src/gateway/server-methods/chat-history-handler.ts",
  "src/gateway/server-methods/cron-wake.ts",
  "src/gateway/server-methods/device-scope-upgrade.ts",
  "src/gateway/server-methods/environments.profiles.ts",
  "src/gateway/server-methods/github-personal-authorization.ts",
  "src/gateway/server-methods/method-authorization.ts",
  "src/gateway/server-methods/models.ts",
  "src/gateway/server-methods/personal-profile-authorization.ts",
  "src/gateway/server-methods/send-role-authorization.ts",
  "src/gateway/server-methods/sessions-sharing-permissions.ts",
  "src/gateway/server-methods/templates-drafts.ts",
  "src/gateway/server-methods/users-background.ts",
  "src/gateway/server-methods/users-model-account-access.ts",
  "src/gateway/server-methods/users-personal-file.ts",
  "src/gateway/server-methods/users-profile-access.ts",
  "src/gateway/server-methods/users-role.ts",
  "src/gateway/server/ws-connection/authenticated-request-dispatch.ts",
  "src/gateway/server/ws-connection/connect-hello.ts",
  "src/gateway/server/ws-connection/connect-openclaw-id-member-grant.ts",
  "src/gateway/server/ws-connection/connect-operator-access.ts",
  "src/gateway/server/ws-connection/connect-session.ts",
  "src/gateway/server/ws-origin-policy.ts",
  "src/gateway/session-access-authority.ts",
  "src/gateway/session-activity-summary-authority.ts",
  "src/gateway/session-communication-approval.ts",
  "src/gateway/session-companion-rpc.ts",
  "src/gateway/session-permission-authorization.ts",
  "src/gateway/session-sharing-policy.ts",
  "src/gateway/session-sharing-read.ts",
  "src/gateway/tools-invoke-shared.ts",
  "src/gateway/web-push-authority.ts",
  "src/skills/library/store.ts",
  "src/state/user-profile-list.ts",
]);

const ROOTS = ["src", "extensions", "packages", BOUNDARY_GUARD_FIXTURE_ROOT];

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Only admission files may read live operator permissions.",
    },
    schema: [
      {
        type: "object",
        properties: { ignoreAllowlists: { type: "boolean" } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const filename = context.physicalFilename.replaceAll("\\", "/");
    const cwd = context.cwd.replaceAll("\\", "/");
    const repoPath = filename.startsWith(`${cwd}/`) ? filename.slice(cwd.length + 1) : filename;
    if (
      !ROOTS.some((root) => pathMatchesTypeAssertionRoot(repoPath, root)) ||
      isSkippedTypeAssertionTestPath(repoPath) ||
      (context.options[0]?.ignoreAllowlists !== true && ADMISSION_FILES.has(repoPath))
    ) {
      return {};
    }
    const reported = new Set();
    return {
      Identifier(node) {
        // Shorthand import, export and destructuring specifiers share one span.
        if (READERS.has(node.name) && !reported.has(node.start)) {
          reported.add(node.start);
          context.report({
            node,
            message: `${node.name} reads live operator permissions after admission. Use the scopes, role and policy on the admitted operator authority; permissions are checked once when work starts.`,
          });
        }
      },
    };
  },
};
