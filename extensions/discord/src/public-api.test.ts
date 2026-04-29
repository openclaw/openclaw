import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildDiscordComponentCustomId,
  parseDiscordComponentCustomIdForInteraction,
} from "./component-custom-id.js";

const API_SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../api.ts");

function collectExportedNames(): Set<string> {
  const source = ts.createSourceFile(
    API_SOURCE_PATH,
    readFileSync(API_SOURCE_PATH, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) {
      continue;
    }
    if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

describe("discord public API barrel", () => {
  it("keeps compatibility exports for existing @openclaw/discord/api.js consumers", () => {
    const exportedNames = collectExportedNames();

    for (const exportName of [
      "DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS",
      "buildDiscordInteractiveComponents",
      "handleDiscordMessageAction",
      "isDiscordExecApprovalApprover",
      "isDiscordExecApprovalClientEnabled",
      "parseApplicationIdFromToken",
      "parseDiscordComponentCustomIdForCarbon",
      "parseDiscordSendTarget",
      "parseDiscordTarget",
      "probeDiscord",
      "resolveDiscordChannelId",
      "resolveDiscordPrivilegedIntentsFromFlags",
    ]) {
      expect(exportedNames).toContain(exportName);
    }
  });

  it("keeps legacy Carbon component parser aliases aligned with interaction parsers", () => {
    const exportedNames = collectExportedNames();
    const customId = buildDiscordComponentCustomId({
      componentId: "approve",
      modalId: "details",
    });

    expect(exportedNames).toContain("parseDiscordComponentCustomIdForCarbon");
    expect(parseDiscordComponentCustomIdForInteraction(customId)).toEqual({
      key: "*",
      data: { cid: "approve", mid: "details" },
    });
  });
});
