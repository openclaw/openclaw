// Static resource-safety guard, not whole-program dataflow analysis. Const aliases and
// literal builtin module names are resolved. Reassigned/let aliases, computed module or
// method names, and filesystem functions hidden behind other modules remain unsupported.
// Escape-sequence names (fs["read\x64ir"]) bypass the prefilter; deliberate obfuscation is out of scope.
const FS_MODULES = new Map([
  ["fs", "fs"],
  ["node:fs", "fs"],
  ["fs/promises", "promises"],
  ["node:fs/promises", "promises"],
  ["module", "module"],
  ["node:module", "module"],
  ["process", "process"],
  ["node:process", "process"],
]);
const WRAPPERS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);
const LOOPS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);
const UNKNOWN = Symbol("unknown");
const ABSENT = Symbol("absent");

function unwrap(node) {
  let current = node;
  while (current && WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  return current;
}
function propertyName(node, computed = false) {
  if (!node) {
    return undefined;
  }
  if (!computed && node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "Literal") {
    return node.value;
  }
  return undefined;
}
function member(receiver, key) {
  if (key === "default") {
    return receiver;
  }
  if (receiver === "module" && key === "createRequire") {
    return "createRequire";
  }
  if (receiver === "process" && key === "getBuiltinModule") {
    return "getBuiltinModule";
  }
  if (receiver === "fs" && key === "promises") {
    return "promises";
  }
  if (
    (receiver === "fs" || receiver === "promises") &&
    (key === "readdir" || key === "readdirSync")
  ) {
    return "read";
  }
  return undefined;
}

export default {
  meta: {
    type: "problem",
    messages: {
      unsafe:
        "Recursive readdir can follow directory symlinks and exhaust memory. Use listDirectoryTreeStrict/listDirectoryTreeStrictSync from src/infra/directory-walk (plugins: openclaw/plugin-sdk/file-access-runtime).",
      unverifiable:
        "Cannot verify nonrecursive readdir options. Use listDirectoryTreeStrict/listDirectoryTreeStrictSync, or pass statically known options with recursive:false (or no recursive option).",
    },
  },
  create(context) {
    // Avoid materializing JS AST/scope wrappers for the vast majority of source files.
    if (!context.sourceCode.text.includes("readdir")) {
      return {};
    }
    // Resource exhaustion is equally dangerous in tests, QA, UI, packages and tooling.
    // Unlike type/assertion policy, this rule covers every file admitted by oxlint.
    const references = new Map();
    const variableFor = (node) => references.get(node.start);
    function initializer(node, visited) {
      const variable = variableFor(node);
      if (!variable || visited.has(variable)) {
        return undefined;
      }
      const definition = variable.defs[0];
      if (
        definition?.type !== "Variable" ||
        definition.parent.kind !== "const" ||
        variable.references.some((reference) => reference.isWrite() && !reference.init)
      ) {
        return undefined;
      }
      visited.add(variable);
      return definition.node;
    }
    function kind(expression, visited = new Set()) {
      const node = unwrap(expression);
      if (!node) {
        return undefined;
      }
      if (node.type === "MemberExpression") {
        return member(kind(node.object, visited), propertyName(node.property, node.computed));
      }
      if (node.type === "AwaitExpression") {
        return kind(node.argument, visited);
      }
      if (node.type === "ImportExpression") {
        return FS_MODULES.get(propertyName(node.source, true));
      }
      if (node.type === "CallExpression") {
        const callee = kind(node.callee, visited);
        if (callee === "createRequire") {
          return "require";
        }
        if (callee === "require" || callee === "getBuiltinModule") {
          return FS_MODULES.get(propertyName(node.arguments[0], true));
        }
      }
      if (node.type !== "Identifier") {
        return undefined;
      }
      const variable = variableFor(node);
      const definition = variable?.defs[0];
      if (!definition && (node.name === "require" || node.name === "process")) {
        return node.name;
      }
      if (definition?.type === "ImportBinding") {
        const declaration = definition.parent;
        const source =
          declaration.type === "TSImportEqualsDeclaration"
            ? declaration.moduleReference.type === "TSExternalModuleReference"
              ? declaration.moduleReference.expression
              : undefined
            : declaration.source;
        const receiver = FS_MODULES.get(propertyName(source, true));
        return definition.node.type === "ImportSpecifier"
          ? member(receiver, propertyName(definition.node.imported))
          : receiver;
      }
      const binding = initializer(node, visited);
      if (!binding?.init) {
        return undefined;
      }
      const receiver = kind(binding.init, visited);
      if (binding.id.type === "Identifier") {
        return receiver;
      }
      if (binding.id.type === "ObjectPattern") {
        const property = binding.id.properties.find(
          (candidate) =>
            candidate.type === "Property" &&
            candidate.value.type === "Identifier" &&
            variable.identifiers.some((id) => id.start === candidate.value.start),
        );
        return property
          ? member(receiver, propertyName(property.key, property.computed))
          : undefined;
      }
      return undefined;
    }
    function literal(expression, visited = new Set()) {
      const node = unwrap(expression);
      if (node?.type === "Literal") {
        return node.value;
      }
      if (node?.type === "Identifier") {
        if (node.name === "undefined" && !variableFor(node)?.defs.length) {
          return undefined;
        }
        const binding = initializer(node, visited);
        if (binding?.id.type === "Identifier") {
          return literal(binding.init, visited);
        }
      }
      return UNKNOWN;
    }
    function optionsRemainLocal(variable, use) {
      if (variable.defs[0]?.parent.parent?.type === "ExportNamedDeclaration") {
        return false;
      }
      const useScope = context.sourceCode.getScope(use).variableScope;
      let insideLoop = false;
      for (let parent = use.parent; parent && parent !== useScope.block; parent = parent.parent) {
        if (LOOPS.has(parent.type)) {
          insideLoop = true;
          break;
        }
      }
      return variable.references.every((reference) => {
        if (reference.init) {
          return true;
        }
        const captured = reference.from.variableScope !== variable.scope.variableScope;
        // Source order is execution order only within one non-looping scope. A later
        // escape can affect the next iteration or a function invoked after module setup.
        const laterInSameRun =
          !captured &&
          !insideLoop &&
          reference.from.variableScope === useScope &&
          reference.identifier.start >= use.start;
        let node = reference.identifier;
        while (WRAPPERS.has(node.parent?.type)) {
          node = node.parent;
        }
        if (node.parent?.type === "MemberExpression" && node.parent.object === node) {
          while (node.parent?.type === "MemberExpression" && node.parent.object === node) {
            node = node.parent;
          }
          const parent = node.parent;
          if (
            (parent?.type === "AssignmentExpression" && parent.left === node) ||
            parent?.type === "UpdateExpression" ||
            (parent?.type === "UnaryExpression" && parent.operator === "delete")
          ) {
            return false;
          }
          // Calling an object's method can mutate it. Reading a field does not hand it out.
          return laterInSameRun || parent?.type !== "CallExpression" || parent.callee !== node;
        }
        if (laterInSameRun) {
          return true;
        }
        const parent = node.parent;
        if (
          parent?.type === "CallExpression" &&
          parent.arguments[1] === node &&
          kind(parent.callee) === "read"
        ) {
          return true;
        }
        // Assignment, publication, return, aliases and unknown calls can retain or mutate it.
        return parent?.type === "BinaryExpression" || parent?.type === "UnaryExpression";
      });
    }
    function recursion(expression, visited = new Set(), use = expression) {
      const node = unwrap(expression);
      if (!node) {
        return ABSENT;
      }
      if (node.type === "Identifier") {
        const variable = variableFor(node);
        if (variable?.defs.some((definition) => definition.type === "FunctionName")) {
          return ABSENT;
        }
        const binding = initializer(node, visited);
        if (binding?.id.type === "Identifier") {
          const value = unwrap(binding.init);
          if (value?.type === "ArrowFunctionExpression" || value?.type === "FunctionExpression") {
            return ABSENT;
          }
          if (!optionsRemainLocal(variable, use)) {
            return UNKNOWN;
          }
          return recursion(binding.init, visited, use);
        }
        return node.name === "undefined" && !variableFor(node)?.defs.length ? ABSENT : UNKNOWN;
      }
      // Encoding-only calls, null/undefined options, and callback-only readdir do not recurse.
      if (node.type === "Literal" && (node.value === null || typeof node.value === "string")) {
        return ABSENT;
      }
      if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
        return ABSENT;
      }
      if (node.type !== "ObjectExpression") {
        return UNKNOWN;
      }
      let recursive = ABSENT;
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          // An unknown spread may override a previous false; an explicit false after it is safe.
          const spread = recursion(property.argument, new Set(visited), use);
          if (spread !== ABSENT) {
            recursive = spread;
          }
        } else if (property.type === "Property") {
          const key = propertyName(property.key, property.computed);
          if (key === undefined) {
            recursive = UNKNOWN;
          } else if (key === "recursive") {
            recursive =
              property.kind === "init" ? literal(property.value, new Set(visited)) : UNKNOWN;
          }
        }
      }
      return recursive;
    }
    return {
      Program() {
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const reference of scope.references) {
            references.set(reference.identifier.start, reference.resolved);
          }
        }
      },
      CallExpression(node) {
        if (kind(node.callee) !== "read") {
          return;
        }
        const recursive = recursion(node.arguments[1], new Set(), node);
        if (recursive === false || recursive === undefined || recursive === ABSENT) {
          return;
        }
        context.report({ node, messageId: recursive === true ? "unsafe" : "unverifiable" });
      },
    };
  },
};
