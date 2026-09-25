import { Parser } from "acorn";

/**
 * Visit completed statements without retaining the full Program AST.
 * @param {string} source
 * @param {{ sourceType: "script" | "module", allowHashBang?: boolean, allowReturnOutsideFunction?: boolean }} options
 * @param {(statements: import("acorn").Program["body"]) => void} visit
 * @param {typeof Parser} [parser]
 */
export function visitJavaScriptStatements(source, options, visit, parser = Parser) {
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
  parser.parse(source, {
    ecmaVersion: "latest",
    ...options,
    program,
    onToken: visitCompletedStatements,
  });
  visitCompletedStatements();
}
