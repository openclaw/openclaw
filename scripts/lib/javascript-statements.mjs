import { Parser } from "acorn";

// Acorn's scope lists only append names, search with indexOf, and read the first
// catch binding. Keep those arrays and validation rules; index repeated searches.
class AppendOnlyScopeNames extends Array {
  firstIndices = new Map();

  push(...names) {
    const start = this.length;
    const length = super.push(...names);
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      if (!this.firstIndices.has(name)) {
        this.firstIndices.set(name, start + index);
      }
    }
    return length;
  }

  indexOf(name, fromIndex = 0) {
    return fromIndex === 0 ? (this.firstIndices.get(name) ?? -1) : super.indexOf(name, fromIndex);
  }
}

const ArtifactParser = Parser.extend(
  (BaseParser) =>
    class extends BaseParser {
      enterScope(flags) {
        super.enterScope(flags);
        const scope = this.currentScope();
        scope.lexical = new AppendOnlyScopeNames();
        scope.var = new AppendOnlyScopeNames();
        scope.functions = new AppendOnlyScopeNames();
      }
    },
);

/**
 * Visit completed statements without retaining the full Program AST.
 * @param {string} source
 * @param {{ sourceType: "script" | "module", allowHashBang?: boolean, allowReturnOutsideFunction?: boolean }} options
 * @param {(statements: import("acorn").Program["body"]) => void} visit
 */
export function visitJavaScriptStatements(source, options, visit) {
  /** @type {import("acorn").Program} */
  const program = {
    type: "Program",
    start: 0,
    end: 0,
    sourceType: options.sourceType,
    body: [],
  };
  const visitCompletedStatements = () => {
    if (program.body.length > 0) {
      visit(program.body.splice(0));
    }
  };
  // Keep one parser so module bindings, forward exports, and strictness span every batch.
  ArtifactParser.parse(source, {
    ecmaVersion: "latest",
    ...options,
    program,
    onToken: visitCompletedStatements,
  });
  visitCompletedStatements();
}
