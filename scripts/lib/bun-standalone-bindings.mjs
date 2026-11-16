// Native pseudo-globals and import witnesses share one lexical binding owner.
export function createStandaloneLexicalBindings(ast) {
  const scopes = new WeakMap();
  const root = { names: new Set(), callable: true };
  const constants = new WeakMap();
  const writes = [];
  const isFunction = (node) =>
    /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node?.type);
  const bind = (node, scope) => {
    if (!node) {
      return;
    }
    if (node.type === "Identifier") {
      scope.names.add(node.name);
    } else if (node.type === "RestElement") {
      bind(node.argument, scope);
    } else if (node.type === "AssignmentPattern") {
      bind(node.left, scope);
    } else if (node.type === "TSParameterProperty") {
      bind(node.parameter, scope);
    } else if (node.type === "ArrayPattern") {
      node.elements.forEach((entry) => bind(entry, scope));
    } else if (node.type === "ObjectPattern") {
      node.properties.forEach((entry) =>
        bind(entry.type === "RestElement" ? entry.argument : entry.value, scope),
      );
    }
  };
  function visit(node, parent, parentScope) {
    let scope = parentScope;
    if (!node || typeof node !== "object") {
      return;
    }
    const callable = isFunction(node);
    if (
      [
        "FunctionDeclaration",
        "ClassDeclaration",
        "TSEnumDeclaration",
        "TSModuleDeclaration",
        "TSImportEqualsDeclaration",
      ].includes(node.type)
    ) {
      bind(node.id, scope);
    }
    if (
      callable ||
      [
        "BlockStatement",
        "CatchClause",
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
        "SwitchStatement",
        "ClassExpression",
        "StaticBlock",
        "TSModuleBlock",
      ].includes(node.type)
    ) {
      scope = {
        parent: scope,
        names: new Set(),
        callable:
          callable ||
          node.type === "StaticBlock" ||
          node.type === "TSModuleBlock" ||
          (node.type === "BlockStatement" && node === parent?.body && isFunction(parent)),
      };
    }
    scopes.set(node, scope);
    if (callable) {
      bind(node.id, scope);
      node.params.forEach((parameter) => bind(parameter, scope));
    }
    if (node.type === "CatchClause") {
      bind(node.param, scope);
    }
    if (node.type === "ClassExpression") {
      bind(node.id, scope);
    }
    if (node.type === "VariableDeclarator") {
      let target = scope;
      if (parent.kind === "var") {
        while (target.parent && !target.callable) {
          target = target.parent;
        }
      }
      bind(node.id, target);
      if (parent.kind === "const" && node.id.type === "Identifier") {
        const value =
          node.init?.type === "Literal"
            ? node.init.value
            : node.init?.type === "TemplateLiteral" && node.init.expressions.length === 0
              ? node.init.quasis[0].value.cooked
              : undefined;
        if (typeof value === "string") {
          let values = constants.get(target);
          if (!values) {
            values = new Map();
            constants.set(target, values);
          }
          values.set(node.id.name, value);
        }
      }
    }
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
      writes.push(node.left ?? node.argument);
    }
    if (/^Import(?:Default|Namespace)?Specifier$/.test(node.type)) {
      bind(node.local, scope);
    }
    for (const [key, value] of Object.entries(node)) {
      const childScope =
        node.type === "SwitchStatement" && key === "discriminant" ? parentScope : scope;
      if (Array.isArray(value)) {
        value.forEach((child) => visit(child, node, childScope));
      } else if (value && typeof value === "object") {
        visit(value, node, childScope);
      }
    }
  }
  visit(ast, undefined, root);
  const bindingScope = (node) => {
    for (let scope = scopes.get(node); scope; scope = scope.parent) {
      if (scope.names.has(node.name)) {
        return scope;
      }
    }
    return undefined;
  };
  const discardWritten = (node) => {
    if (!node || typeof node !== "object" || node.type === "MemberExpression") {
      return;
    }
    if (node.type === "Identifier") {
      constants.get(bindingScope(node))?.delete(node.name);
    } else if (node.type === "RestElement") {
      discardWritten(node.argument);
    } else if (node.type === "AssignmentPattern") {
      discardWritten(node.left);
    } else if (node.type === "ArrayPattern") {
      node.elements.forEach(discardWritten);
    } else if (node.type === "ObjectPattern") {
      node.properties.forEach((property) =>
        discardWritten(property.type === "RestElement" ? property.argument : property.value),
      );
    }
  };
  writes.forEach(discardWritten);
  return {
    isBound: (node) => Boolean(bindingScope(node)),
    isModuleBinding: (node) => bindingScope(node) === root,
    constantString(node) {
      return node?.type === "Identifier"
        ? constants.get(bindingScope(node))?.get(node.name)
        : undefined;
    },
  };
}
