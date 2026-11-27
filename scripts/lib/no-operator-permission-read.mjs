import {
  BOUNDARY_GUARD_FIXTURE_ROOT,
  isSkippedTypeAssertionTestPath,
  pathMatchesTypeAssertionRoot,
} from "./type-assertion-guard-scope.mjs";

// Live reads of an operator's role, role policy and profile access. A run admits once and then
// keeps the frozen facts on its admitted operator authority (AGENTS.md "Decide authority once").
const READERS = new Set([
  "authorizeCurrentOperatorRoleScopes",
  "captureResidentUserProfileAccess",
  "onOperatorRolePolicyChanged",
  "resolveOperatorRolePolicy",
  "resolveOperatorRolePolicyForAssignment",
  "resolveOperatorRolePolicyForProfile",
  "resolveOperatorRoleSelection",
]);
// The one constructor of run authority. A new caller is how a second decision or a revocation
// signal gets into a started run (#204847).
const MINTER = "createAdmittedRunOperatorAuthority";
const MINTER_OWNER = "src/agents/admitted-run-context.ts";

// Each list maps a file to the references it has today. Shrink only: lower a count when a
// reference goes away. New code takes scopes, role, policy and liveness from the admitted
// operator authority instead of raising a count or joining a list.

// Owners and work starts that may read live permissions.
export const ADMISSION_FILES = new Map([
  ["src/commands/doctor/cron/execution-context-check.ts", 3],
  ["src/flows/doctor-member-roles.store.ts", 2],
  ["src/gateway/agent-turn/agent-session-persist.ts", 2],
  ["src/gateway/assistant-media-policy.ts", 2],
  ["src/gateway/channel-operator-authority.ts", 6],
  ["src/gateway/control-ui-session-pr-read.ts", 4],
  ["src/gateway/factory-github-proof.ts", 2],
  ["src/gateway/github-publication-inspect-reader.ts", 2],
  ["src/gateway/github-publication-requester.ts", 3],
  ["src/gateway/http-auth-user-profile.ts", 5],
  ["src/gateway/human-mention-policy.ts", 7],
  ["src/gateway/ios-approval-push-authority.ts", 2],
  ["src/gateway/openclaw-id/member-profiles.ts", 2],
  ["src/gateway/openclaw-id/member-role-change.ts", 2],
  ["src/gateway/operator-access-policy.ts", 4],
  ["src/gateway/operator-admission.ts", 5],
  ["src/gateway/operator-model-presentation.ts", 2],
  ["src/gateway/operator-role-policy.ts", 25],
  ["src/gateway/operator-run-authority.ts", 3],
  ["src/gateway/project-access.ts", 2],
  ["src/gateway/question-session-access.ts", 4],
  ["src/gateway/remote-control-ui-ingress.ts", 4],
  ["src/gateway/repository-integration-identity.ts", 2],
  ["src/gateway/server-chat-metadata-lifecycle.ts", 2],
  ["src/gateway/server-methods/agents.ts", 6],
  ["src/gateway/server-methods/chat-history-handler.ts", 2],
  ["src/gateway/server-methods/cron-wake.ts", 2],
  ["src/gateway/server-methods/device-scope-upgrade.ts", 3],
  ["src/gateway/server-methods/environments.profiles.ts", 2],
  ["src/gateway/server-methods/github-personal-authorization.ts", 2],
  ["src/gateway/server-methods/method-authorization.ts", 2],
  ["src/gateway/server-methods/models.ts", 2],
  ["src/gateway/server-methods/personal-profile-authorization.ts", 6],
  ["src/gateway/server-methods/send-role-authorization.ts", 2],
  ["src/gateway/server-methods/sessions-sharing-permissions.ts", 4],
  ["src/gateway/server-methods/templates-drafts.ts", 2],
  ["src/gateway/server-methods/users-background.ts", 2],
  ["src/gateway/server-methods/users-model-account-access.ts", 2],
  ["src/gateway/server-methods/users-personal-file.ts", 2],
  ["src/gateway/server-methods/users-profile-access.ts", 2],
  ["src/gateway/server-methods/users-role.ts", 2],
  ["src/gateway/server/ws-connection/authenticated-request-dispatch.ts", 2],
  ["src/gateway/server/ws-connection/connect-hello.ts", 4],
  ["src/gateway/server/ws-connection/connect-openclaw-id-member-grant.ts", 2],
  ["src/gateway/server/ws-connection/connect-operator-access.ts", 4],
  ["src/gateway/server/ws-connection/connect-session.ts", 2],
  ["src/gateway/server/ws-origin-policy.ts", 3],
  ["src/gateway/session-access-authority.ts", 4],
  ["src/gateway/session-activity-summary-authority.ts", 4],
  ["src/gateway/session-communication-approval.ts", 2],
  ["src/gateway/session-companion-rpc.ts", 2],
  ["src/gateway/session-permission-authorization.ts", 2],
  ["src/gateway/session-sharing-policy.ts", 4],
  ["src/gateway/session-sharing-read.ts", 9],
  ["src/gateway/tools-invoke-shared.ts", 5],
  ["src/gateway/web-push-authority.ts", 2],
  ["src/skills/library/store.ts", 2],
  ["src/state/user-profile-list.ts", 1],
]);

// Files that build run authority. Admission is the owner; the others pass admitted authority on.
export const MINT_FILES = new Map([
  ["src/gateway/cron-stream-sandbox-authority.ts", 2],
  ["src/gateway/operator-admission.ts", 2],
  ["src/gateway/operator-run-authority.ts", 4],
  ["src/gateway/operator-run-invocation.ts", 3],
  ["src/gateway/operator-run-recovery.ts", 2],
  ["src/gateway/session-sharing-authorization-async.ts", 2],
  ["src/plugin-sdk/plugin-test-runtime.ts", 2],
]);

// Requests that re-check their connection's access after admission.
export const ACCESS_RECHECK_FILES = new Map([
  ["src/gateway/question-session-access.ts", 3],
  ["src/gateway/session-communication-approval.ts", 1],
]);

const ROOTS = ["src", "extensions", "packages", BOUNDARY_GUARD_FIXTURE_ROOT];

const CHECKS = {
  read: {
    files: ADMISSION_FILES,
    message: (name) =>
      `Permission read: ${name} reads live operator permissions after admission. Use the scopes, role and policy on the admitted operator authority; permissions are checked once when work starts.`,
  },
  mint: {
    files: MINT_FILES,
    message: () =>
      `Run authority minted: ${MINTER} outside admission. Pass the admitted run authority on; a started run keeps it until it ends.`,
  },
  recheck: {
    files: ACCESS_RECHECK_FILES,
    message: () =>
      "Access re-check: operatorAccessAuthority.assertCurrent() after the request started. Access is checked once when the request is admitted; a started request finishes.",
  },
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Only admission files may read live operator permissions, mint run authority or re-check access.",
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
      isSkippedTypeAssertionTestPath(repoPath)
    ) {
      return {};
    }
    const ignoreAllowlists = context.options[0]?.ignoreAllowlists === true;
    const seen = new Set();
    const counts = { read: 0, mint: 0, recheck: 0 };
    const report = (kind, node) => {
      // Shorthand import, export and destructuring specifiers share one span.
      if (seen.has(node.start)) {
        return;
      }
      seen.add(node.start);
      counts[kind] += 1;
      if (ignoreAllowlists || counts[kind] > (CHECKS[kind].files.get(repoPath) ?? 0)) {
        context.report({ node, message: CHECKS[kind].message(node.name) });
      }
    };
    return {
      Identifier(node) {
        if (READERS.has(node.name)) {
          report("read", node);
        } else if (node.name === MINTER && repoPath !== MINTER_OWNER) {
          report("mint", node);
        }
      },
      MemberExpression(node) {
        if (
          node.property.name === "assertCurrent" &&
          node.object.type === "MemberExpression" &&
          node.object.property.name === "operatorAccessAuthority"
        ) {
          report("recheck", node.property);
        }
      },
    };
  },
};
