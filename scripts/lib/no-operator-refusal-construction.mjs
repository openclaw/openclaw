import {
  BOUNDARY_GUARD_FIXTURE_ROOT,
  isSkippedTypeAssertionTestPath,
  pathMatchesTypeAssertionRoot,
} from "./type-assertion-guard-scope.mjs";

// Refusal text comes from the cause table in src/gateway/operator-refusal.ts. Shrink only: these
// files still refuse work themselves. A new refusal comes from admission, not a new file here.
export const REFUSAL_FILES = new Set([
  "src/gateway/github-publication-actions.ts",
  "src/gateway/github-publication-inspect-reader.ts",
  "src/gateway/github-publication-inspect.ts",
  "src/gateway/github-publication-requester.ts",
  "src/gateway/openclaw-id/tunnel-principal.ts",
  "src/gateway/operator-admission.ts",
  "src/gateway/operator-run-recovery.ts",
  "src/gateway/remote-ingress-principal-recovery.ts",
  "src/gateway/session-participation-recovery.ts",
]);

const OWNER = "src/gateway/operator-refusal.ts";
const REFUSAL = "OperatorRefusalError";
const ROOTS = ["src", "extensions", "packages", BOUNDARY_GUARD_FIXTURE_ROOT];

export default {
  meta: {
    type: "problem",
    docs: { description: "Only the refusal owner and listed files may build operator refusals." },
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
      repoPath === OWNER ||
      !ROOTS.some((root) => pathMatchesTypeAssertionRoot(repoPath, root)) ||
      isSkippedTypeAssertionTestPath(repoPath) ||
      (context.options[0]?.ignoreAllowlists !== true && REFUSAL_FILES.has(repoPath))
    ) {
      return {};
    }
    const report = (node) =>
      context.report({
        node,
        message: `${REFUSAL} is built outside admission. Refuse the work when it is admitted, with a cause from ${OWNER}.`,
      });
    const checkClass = (node) => {
      if (node.superClass?.type === "Identifier" && node.superClass.name === REFUSAL) {
        report(node.superClass);
      }
    };
    return {
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === REFUSAL) {
          report(node.callee);
        }
      },
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    };
  },
};
