import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS } from "./notification-policy.js";

it("never opts out of a method named by an incoming notification consumer", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const optedOut = new Set<string>(CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS);
  const consumers: string[] = [];
  for (const relative of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const file = relative.split(path.sep).join("/");
    if (
      !file.endsWith(".ts") ||
      /(?:\.test|test-support|test-helpers|test-harness)/u.test(file) ||
      file === "app-server/notification-policy.ts" ||
      file.startsWith("app-server/protocol-generated/")
    ) {
      continue;
    }
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(root, relative), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && optedOut.has(node.text)) {
        const parent = node.parent;
        // This is an outgoing event on the separate exec-server protocol.
        const isExecServerEmission =
          file === "app-server/sandbox-exec-server/processes.ts" &&
          ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          ts.isPropertyAccessExpression(parent.expression) &&
          parent.expression.name.text === "emitNotification";
        if (!isExecServerEmission) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          consumers.push(`${file}:${line + 1}: ${node.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(consumers).toEqual([]);
});
