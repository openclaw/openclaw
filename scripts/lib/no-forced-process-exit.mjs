import { getChangedPathFacts, isTestSupportFileTarget } from "./changed-path-facts.mjs";
import { classifyBundledExtensionSourcePath } from "./extension-source-classifier.mts";
import {
  BOUNDARY_GUARD_FIXTURE_ROOT,
  TYPE_ASSERTION_PRODUCTION_ROOTS,
  pathMatchesTypeAssertionRoot,
} from "./type-assertion-guard-scope.mjs";

// Published standalone entrypoints, not the developer tooling directory:
// immutable adoption installs the first; updating.md documents the packaged FreeBSD diagnostic.
const RUNTIME_SCRIPT_ENTRYPOINTS = new Set([
  "scripts/openclaw-immutable-launcher.mjs",
  "scripts/freebsd-service-inspect.mjs",
]);

const PROCESS_MODULES = new Set(["process", "node:process"]);
const FORCED_EXITS = new Set(["exit", "reallyExit"]);
const WRAPPERS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function unwrap(node) {
  let current = node;
  while (WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  return current;
}

function propertyName(node, computed) {
  if (!computed && node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "Literal") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function memberKind(receiver, property) {
  if (receiver === "global" && property === "process") {
    return "process";
  }
  if (receiver === "process") {
    if (property === "default") {
      return "process";
    }
    if (FORCED_EXITS.has(property)) {
      return "exit";
    }
  }
  return null;
}

// String contents are not source AST. Generated-program owners verify rendered
// entrypoints at executable test sinks with forced-exit traps or beforeExit witnesses.
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require natural process shutdown instead of forced Node.js termination.",
      url: "https://github.com/nodejs/node/issues/64274",
    },
    messages: {
      forcedExit:
        "Do not force termination with process.exit/reallyExit: V8 can deadlock joining a worker that is waiting for main-thread GC (https://github.com/nodejs/node/issues/64274). Await owned cleanup, set process.exitCode, and return so Node.js exits naturally.",
    },
  },
  create(context) {
    const filename = context.physicalFilename.replaceAll("\\", "/");
    const cwd = context.cwd.replaceAll("\\", "/");
    const repoPath = filename.startsWith(`${cwd}/`) ? filename.slice(cwd.length + 1) : filename;
    if (!pathMatchesTypeAssertionRoot(repoPath, BOUNDARY_GUARD_FIXTURE_ROOT)) {
      const facts = getChangedPathFacts(repoPath);
      const source = classifyBundledExtensionSourcePath(repoPath);
      const isRuntimeRoot =
        TYPE_ASSERTION_PRODUCTION_ROOTS.some((root) =>
          pathMatchesTypeAssertionRoot(repoPath, root),
        ) ||
        (!repoPath.includes("/") && /\.[cm]?js$/u.test(repoPath)) ||
        RUNTIME_SCRIPT_ENTRYPOINTS.has(repoPath);
      // Apply the canonical tooling classification inside each package as well.
      // A plugin scripts/ build helper is not its src/ runtime; runtime-api barrels
      // are still checked (the classifier excludes those only for its barrel guards).
      const packageLocalPath = repoPath.replace(/^(?:extensions|packages)\/[^/]+\//u, "");
      const packageSurface = getChangedPathFacts(packageLocalPath).surface;
      const isPackageTooling =
        packageLocalPath !== repoPath &&
        (packageSurface === "rootTooling" || packageSurface === "rootGlobal");
      if (
        !isRuntimeRoot ||
        !source.isCodeFile ||
        source.isTestLike ||
        source.isInfraArtifact ||
        facts.isTestOnly ||
        isTestSupportFileTarget(repoPath) ||
        isPackageTooling
      ) {
        return {};
      }
    }

    const references = new Map();
    function valueKind(expression, visited = new Set()) {
      const node = unwrap(expression);
      if (node.type === "MemberExpression") {
        return memberKind(
          valueKind(node.object, visited),
          propertyName(node.property, node.computed),
        );
      }
      if (node.type === "AwaitExpression") {
        return valueKind(node.argument, visited);
      }
      if (node.type === "ImportExpression") {
        return PROCESS_MODULES.has(propertyName(node.source, true)) ? "process" : null;
      }
      if (
        node.type === "CallExpression" &&
        node.arguments.length === 1 &&
        valueKind(node.callee, visited) === "require" &&
        PROCESS_MODULES.has(propertyName(node.arguments[0], true))
      ) {
        return "process";
      }
      if (node.type !== "Identifier") {
        return null;
      }
      const variable = references.get(node.start);
      if (!variable || variable.defs.length === 0) {
        if (node.name === "process" || node.name === "require") {
          return node.name;
        }
        return node.name === "globalThis" || node.name === "global" ? "global" : null;
      }
      if (visited.has(variable)) {
        return null;
      }
      const nextVisited = new Set([...visited, variable]);
      for (const definition of variable.defs) {
        if (
          definition.type === "ImportBinding" &&
          PROCESS_MODULES.has(definition.parent.source.value)
        ) {
          const specifier = definition.node;
          return specifier.type === "ImportSpecifier"
            ? memberKind("process", propertyName(specifier.imported, false))
            : "process";
        }
        // Follow stable lexical aliases, not assignments or cross-function data flow.
        if (
          definition.type !== "Variable" ||
          !definition.node.init ||
          variable.references.some((reference) => reference.isWrite() && !reference.init)
        ) {
          continue;
        }
        const { id, init } = definition.node;
        const kind = valueKind(init, nextVisited);
        if (id.type === "Identifier") {
          return kind;
        }
        if (id.type === "ObjectPattern") {
          const property = id.properties.find(
            (candidate) =>
              candidate.type === "Property" &&
              candidate.value.type === "Identifier" &&
              variable.identifiers.some((identifier) => identifier.start === candidate.value.start),
          );
          return property ? memberKind(kind, propertyName(property.key, property.computed)) : null;
        }
      }
      return null;
    }

    const report = (node) => context.report({ node, messageId: "forcedExit" });
    return {
      Program() {
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const reference of scope.references) {
            references.set(reference.identifier.start, reference.resolved);
          }
        }
      },
      // Reject obtaining the function as well as calling it: callbacks, .call,
      // .apply, .bind, and renamed exit aliases must not bypass the policy.
      MemberExpression(node) {
        if (
          FORCED_EXITS.has(propertyName(node.property, node.computed)) &&
          valueKind(node.object) === "process"
        ) {
          report(node);
        }
      },
      ImportSpecifier(node) {
        if (
          node.importKind !== "type" &&
          node.parent.importKind !== "type" &&
          PROCESS_MODULES.has(node.parent.source.value) &&
          FORCED_EXITS.has(propertyName(node.imported, false))
        ) {
          report(node);
        }
      },
      VariableDeclarator(node) {
        if (!node.init || node.id.type !== "ObjectPattern" || valueKind(node.init) !== "process") {
          return;
        }
        for (const property of node.id.properties) {
          if (
            property.type === "Property" &&
            FORCED_EXITS.has(propertyName(property.key, property.computed))
          ) {
            report(property);
          }
        }
      },
    };
  },
};
