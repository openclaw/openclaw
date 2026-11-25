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
// or is `false`/`undefined`, is not a producer. Every entry below still sets the bit itself.
const OWNER_FIELDS = new Set(["senderIsOwner", "requesterOwner"]);
export const OWNER_PRODUCER_FILES = new Set([
  // Principals admission does not see yet: they match their own credential or owner config.
  "extensions/discord/src/monitor/native-command-auth.ts", // native slash command, no turn yet
  "extensions/discord/src/voice/speaker-context.ts", // realtime voice speaker, `ownerAllowFrom`
  // FaceTime callers match the plugin's own `ownerHandles`; moving them into
  // `commands.ownerAllowFrom` is a config migration that waits on an owner decision.
  "extensions/facetime/src/call-events.ts",
  "extensions/facetime/src/talk-consult-controller.ts", // same caller claim
  // Channel command owner: the `commands.ownerAllowFrom` config match. Asserted-identity owners
  // and pre-turn senders have no grant yet, so this fact still sets the bit.
  "src/auto-reply/command-auth.ts",
  "src/auto-reply/reply/reply-source-admission.ts",
  "src/gateway/agent-turn/agent-run-user-turn.ts",
  "src/gateway/talk/client-tool-authority.ts", // Talk caller: admin scope + `ownerAllowFrom` match
  // Scheduled and requester-owner continuations (cron creator authority).
  "src/agents/openclaw-plugin-tools.ts",
  "src/agents/openclaw-tools.ts",
  "src/agents/scheduled-message-invocation.ts",
  "src/channels/plugins/message-action-dispatch.ts", // scheduled write: the job's operator
  "src/cron/execution-context-registry.ts",
  "src/plugins/tool-factory-context.ts",
  // Recorded data read back, never decided: protocol field, transcript and lineage receipts.
  "packages/gateway-protocol/src/schema/agent.ts",
  "src/auto-reply/reply/memory-flush-prepare.ts",
  "src/gateway/session-transcript-message.ts",
  "src/plugins/memory-audience.ts",
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

/**
 * Passing the same name along, `….grant.owner`, `false` and `undefined` produce nothing. Neither
 * do forms that can only narrow one: `x === true`, a choice between pass-throughs, `x && y` with
 * one side passed along, and a getter that returns a pass-through.
 */
function passesOwnerAlong(value, field) {
  if (!value) {
    return true;
  }
  switch (value.type) {
    case "ChainExpression":
      return passesOwnerAlong(value.expression, field);
    case "Literal":
      return value.value === false;
    case "Identifier":
      return value.name === field || value.name === "undefined";
    case "MemberExpression": {
      const name = memberName(value);
      return name === field || (name === "owner" && memberName(value.object) === "grant");
    }
    case "BinaryExpression":
      return (
        value.operator === "===" &&
        value.right.type === "Literal" &&
        value.right.value === true &&
        passesOwnerAlong(value.left, field)
      );
    case "ConditionalExpression":
      return passesOwnerAlong(value.consequent, field) && passesOwnerAlong(value.alternate, field);
    case "LogicalExpression":
      return value.operator === "&&"
        ? passesOwnerAlong(value.left, field) || passesOwnerAlong(value.right, field)
        : passesOwnerAlong(value.left, field) && passesOwnerAlong(value.right, field);
    default:
      return false;
  }
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
          !checkOwner ||
          !field ||
          !OWNER_FIELDS.has(field) ||
          node.parent?.type !== "ObjectExpression"
        ) {
          return;
        }
        // A getter is read as its value: one `return` of a pass-through passes along.
        const [statement, ...rest] = node.kind === "get" ? node.value.body.body : [];
        const value =
          node.kind !== "get"
            ? node.value
            : rest.length === 0 && statement?.type === "ReturnStatement"
              ? statement.argument
              : node.value;
        if (!passesOwnerAlong(value, field)) {
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
