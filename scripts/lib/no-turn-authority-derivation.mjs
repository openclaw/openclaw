import {
  BOUNDARY_GUARD_FIXTURE_ROOT,
  isSkippedTypeAssertionTestPath,
  pathMatchesTypeAssertionRoot,
} from "./type-assertion-guard-scope.mjs";

// What a turn may do comes from one place: the grant `decideTurnGrant` puts on the admitted
// operator authority. Entry kinds gather facts; they never decide. Every list below is shrink
// only, and test/scripts/oxlint-boundary-guards.test.ts pins its ceiling and its staleness.

// Turn-kind flags and second owner deciders. Reading one outside its list fails.
const TURN_FLAGS = new Set([
  "reconnectResumeRequested",
  "isLinkedOwnerDevice",
  "isAuthenticatedOwner",
  "recordedOperatorAuthority",
  "senderIsOwnerByScope",
  "isHumanTurn",
  "canPrepareSkillAuthoring",
  "prepareCommandOwnerAuthority",
  "isConfiguredCommandOwner",
]);
export const TURN_FLAG_FILES = new Set([
  "src/agents/tools/gateway-tool.ts",
  "src/auto-reply/command-auth.ts",
  "src/auto-reply/reply/reply-source-admission.ts",
  "src/auto-reply/reply/session-event-target.ts",
  "src/auto-reply/reply/session.ts",
  "src/commands/doctor/cron/execution-context-check.ts",
  "src/cron/execution-context-admission.ts",
  "src/gateway/agent-turn/agent-run-user-turn.ts",
  "src/gateway/approval-channel-custody.ts",
  "src/gateway/operator-admission.ts",
  "src/gateway/operator-run-authority.ts",
  "src/gateway/server-methods/chat-send-request.ts",
  "src/gateway/server-methods/chat-user-turn-recorder.ts",
  "src/gateway/server-methods/restart.ts",
  "src/gateway/server-methods/update-run.ts",
  "src/gateway/server-methods/update.ts",
  "src/gateway/update-run-notice-target.ts",
  "src/infra/outbound/delivery-queue-recovery-params.ts",
  "src/infra/update-requester-authority.ts",
]);

// Owner status has one producer: `grant.owner`. A value that only passes the same name along,
// or is `false`/`undefined`, is not a producer.
const OWNER_FIELDS = new Set(["senderIsOwner", "requesterOwner"]);
export const OWNER_PRODUCER_FILES = new Set([
  "extensions/codex/index.ts",
  "extensions/discord/src/monitor/native-command-auth.ts",
  "extensions/discord/src/voice/speaker-context.ts",
  "extensions/facetime/src/call-events.ts",
  "extensions/facetime/src/talk-consult-controller.ts",
  "extensions/voice-call/src/webhook.ts",
  "packages/gateway-protocol/src/schema/agent.ts",
  "packages/memory-host-sdk/src/host/session-entry-projection.ts",
  "src/agents/agent-command-local.ts",
  "src/agents/agent-command.ts",
  "src/agents/cli-runner/mcp-grant-context.ts",
  "src/agents/embedded-agent-runner/compaction-runtime-context.ts",
  "src/agents/openclaw-plugin-tools.ts",
  "src/agents/openclaw-tools.ts",
  "src/agents/scheduled-message-invocation.ts",
  "src/auto-reply/command-auth.ts",
  "src/auto-reply/reply/agent-runner-question-input.ts",
  "src/auto-reply/reply/agent-runner-steer-adoption.ts",
  "src/auto-reply/reply/get-reply-run-execute.ts",
  "src/auto-reply/reply/memory-flush-prepare.ts",
  "src/auto-reply/reply/reply-source-admission.ts",
  "src/auto-reply/reply/session-event-context.ts",
  "src/auto-reply/reply/session-event-target.ts",
  "src/channels/plugins/message-action-dispatch.ts",
  "src/commands/message.ts",
  "src/cron/execution-context-admission.ts",
  "src/cron/execution-context-registry.ts",
  "src/gateway/agent-turn/agent-run-user-turn.ts",
  "src/gateway/cron-job-turn-target.ts",
  "src/gateway/mcp-http.request.ts",
  "src/gateway/openai-compatible-http.ts",
  "src/gateway/server-methods/conversations.ts",
  "src/gateway/server-methods/send.ts",
  "src/gateway/server-methods/tools-invoke.ts",
  "src/gateway/session-resource-tool-policy.ts",
  "src/gateway/session-transcript-message.ts",
  "src/gateway/talk/client-tool-authority.ts",
  "src/gateway/tool-resolution-authority.ts",
  "src/gateway/tool-resolution.ts",
  "src/mcp/codex-supervision-tools-serve.ts",
  "src/plugins/memory-audience.ts",
  "src/plugins/plugin-command-execution.ts",
  "src/plugins/registry-registrars.ts",
  "src/plugins/registry-runtime.ts",
  "src/plugins/runtime/runtime-agent.ts",
  "src/plugins/tool-factory-context.ts",
  "src/sessions/user-turn-transcript.metadata.ts",
  "src/talk/agent-consult-runtime.ts",
  "src/worker/embedded-agent.runtime.ts",
]);

// Capability modules read the grant, never how the turn started. Deny list, because transcript
// and delivery code read provenance legitimately.
const CAPABILITY_MODULES = new Set([
  "src/gateway/skill-library-authoring.ts",
  "src/gateway/server-methods/chat-send-question-replacement.ts",
  "src/gateway/server-methods/cron-creator-authority-admission.ts",
  "src/auto-reply/reply/session-event-context.ts",
  "src/agents/agent-tools.turn-authority.ts",
  "src/security/dangerous-tools.ts",
  "src/agents/automations-run-scope.ts",
  `${BOUNDARY_GUARD_FIXTURE_ROOT}/turn-authority-derivation-violation.ts`,
]);
const isCapabilityModule = (path) =>
  CAPABILITY_MODULES.has(path) ||
  (path.startsWith("src/gateway/github-publication-") && path.endsWith(".ts"));
const PROVENANCE_READS = new Set([
  "systemInputProvenance",
  "inputProvenance",
  "turnKind",
  "trigger",
  "syntheticClient",
  "clientInfo",
]);
export const CAPABILITY_PROVENANCE_FILES = new Set([
  "src/agents/agent-tools.turn-authority.ts",
  "src/agents/automations-run-scope.ts",
  "src/gateway/server-methods/cron-creator-authority-admission.ts",
  "src/gateway/skill-library-authoring.ts",
]);

const ROOTS = ["src", "extensions", "packages", BOUNDARY_GUARD_FIXTURE_ROOT];

const propertyName = (node) =>
  node?.type === "Identifier"
    ? node.name
    : node?.type === "Literal" && typeof node.value === "string"
      ? node.value
      : undefined;

const memberName = (node) =>
  node?.type === "MemberExpression" && !node.computed ? propertyName(node.property) : undefined;

/** Passing the same name along, `….grant.owner`, `false` and `undefined` produce nothing. */
function passesOwnerAlong(value, field) {
  if (!value) {
    return true;
  }
  if (value.type === "ChainExpression") {
    return passesOwnerAlong(value.expression, field);
  }
  if (value.type === "Literal" && value.value === false) {
    return true;
  }
  if (value.type === "Identifier") {
    return value.name === field || value.name === "undefined";
  }
  if (value.type === "MemberExpression" && !value.computed) {
    const name = memberName(value);
    return name === field || (name === "owner" && memberName(value.object) === "grant");
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Only Gateway admission decides what a turn may do.",
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
    const listed = (list) => context.options[0]?.ignoreAllowlists !== true && list.has(repoPath);
    const checkFlags = !listed(TURN_FLAG_FILES);
    const checkOwner = !listed(OWNER_PRODUCER_FILES);
    const checkProvenance = isCapabilityModule(repoPath) && !listed(CAPABILITY_PROVENANCE_FILES);
    if (!checkFlags && !checkOwner && !checkProvenance) {
      return {};
    }
    const reported = new Set();
    const report = (node, message) => {
      // Shorthand import, export and destructuring specifiers share one span.
      if (!reported.has(node.start)) {
        reported.add(node.start);
        context.report({ node, message });
      }
    };
    const reportOwner = (node, field) =>
      report(
        node,
        `Owner status: ${field} is produced outside admission. Read grant.owner from the admitted operator authority.`,
      );
    return {
      Identifier(node) {
        if (checkFlags && TURN_FLAGS.has(node.name)) {
          report(
            node,
            `Turn-kind flag: ${node.name} decides what a turn may do outside admission. Read the grant on the admitted operator authority.`,
          );
        } else if (checkProvenance && PROVENANCE_READS.has(node.name)) {
          report(
            node,
            `Capability module: ${node.name} reads how the turn started. Read the grant on the admitted operator authority instead.`,
          );
        }
      },
      Property(node) {
        const field = node.computed ? undefined : propertyName(node.key);
        if (
          checkOwner &&
          field &&
          OWNER_FIELDS.has(field) &&
          node.parent?.type === "ObjectExpression" &&
          !passesOwnerAlong(node.value, field)
        ) {
          reportOwner(node, field);
        }
      },
      AssignmentExpression(node) {
        const field = node.left.type === "Identifier" ? node.left.name : memberName(node.left);
        if (
          checkOwner &&
          field &&
          OWNER_FIELDS.has(field) &&
          !passesOwnerAlong(node.right, field)
        ) {
          reportOwner(node, field);
        }
      },
      VariableDeclarator(node) {
        const field = node.id.type === "Identifier" ? node.id.name : undefined;
        if (checkOwner && field && OWNER_FIELDS.has(field) && !passesOwnerAlong(node.init, field)) {
          reportOwner(node, field);
        }
      },
      // Destructuring and parameter defaults: `{ senderIsOwner = true } = input`, with either
      // the source property or the destination binding named as an owner field.
      AssignmentPattern(node) {
        const field = [
          node.left.type === "Identifier" ? node.left.name : undefined,
          node.parent?.type === "Property" && node.parent.value === node && !node.parent.computed
            ? propertyName(node.parent.key)
            : undefined,
        ].find((name) => name !== undefined && OWNER_FIELDS.has(name));
        if (checkOwner && field && !passesOwnerAlong(node.right, field)) {
          reportOwner(node, field);
        }
      },
    };
  },
};
