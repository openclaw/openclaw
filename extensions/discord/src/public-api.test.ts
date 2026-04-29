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
const itOnSupportedNode = Number(process.versions.node.split(".")[0]) >= 22 ? it : it.skip;

const FORMER_PUBLIC_API_EXPORTS = [
  "DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS",
  "DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS",
  "DISCORD_COMPONENT_ATTACHMENT_PREFIX",
  "DISCORD_COMPONENT_CUSTOM_ID_KEY",
  "DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS",
  "DISCORD_DEFAULT_LISTENER_TIMEOUT_MS",
  "DISCORD_MODAL_CUSTOM_ID_KEY",
  "DiscordApplicationSummary",
  "DiscordComponentBlock",
  "DiscordComponentBuildResult",
  "DiscordComponentButtonSpec",
  "DiscordComponentButtonStyle",
  "DiscordComponentEntry",
  "DiscordComponentMessageSpec",
  "DiscordComponentModalFieldType",
  "DiscordComponentSectionAccessory",
  "DiscordComponentSelectOption",
  "DiscordComponentSelectSpec",
  "DiscordComponentSelectType",
  "DiscordCredentialStatus",
  "DiscordFormModal",
  "DiscordInteractiveHandlerContext",
  "DiscordInteractiveHandlerRegistration",
  "DiscordModalEntry",
  "DiscordModalFieldDefinition",
  "DiscordModalFieldSpec",
  "DiscordModalSpec",
  "DiscordPluralKitConfig",
  "DiscordPrivilegedIntentStatus",
  "DiscordPrivilegedIntentsSummary",
  "DiscordProbe",
  "DiscordSendComponents",
  "DiscordSendEmbeds",
  "DiscordSendResult",
  "DiscordTarget",
  "DiscordTargetKind",
  "DiscordTargetParseOptions",
  "DiscordTokenResolution",
  "InspectedDiscordAccount",
  "PluralKitMemberInfo",
  "PluralKitMessageInfo",
  "PluralKitSystemInfo",
  "ResolvedDiscordAccount",
  "buildDiscordComponentCustomId",
  "buildDiscordComponentMessage",
  "buildDiscordComponentMessageFlags",
  "buildDiscordInteractiveComponents",
  "buildDiscordModalCustomId",
  "collectDiscordSecurityAuditFindings",
  "collectDiscordStatusIssues",
  "createDiscordActionGate",
  "createDiscordFormModal",
  "discordPlugin",
  "discordSetupPlugin",
  "fetchDiscordApplicationId",
  "fetchDiscordApplicationSummary",
  "fetchPluralKitMessageInfo",
  "formatDiscordComponentEventText",
  "getDiscordExecApprovalApprovers",
  "handleDiscordMessageAction",
  "handleDiscordSubagentDeliveryTarget",
  "handleDiscordSubagentEnded",
  "handleDiscordSubagentSpawning",
  "inspectDiscordAccount",
  "isDiscordExecApprovalApprover",
  "isDiscordExecApprovalClientEnabled",
  "listDiscordAccountIds",
  "listDiscordDirectoryGroupsFromConfig",
  "listDiscordDirectoryPeersFromConfig",
  "listEnabledDiscordAccounts",
  "looksLikeDiscordTargetId",
  "mergeDiscordAccountConfig",
  "normalizeDiscordMessagingTarget",
  "normalizeDiscordOutboundTarget",
  "normalizeExplicitDiscordSessionKey",
  "parseApplicationIdFromToken",
  "parseDiscordComponentCustomId",
  "parseDiscordComponentCustomIdForCarbon",
  "parseDiscordComponentCustomIdForInteraction",
  "parseDiscordModalCustomId",
  "parseDiscordModalCustomIdForCarbon",
  "parseDiscordModalCustomIdForInteraction",
  "parseDiscordTarget",
  "probeDiscord",
  "readDiscordComponentSpec",
  "resolveDefaultDiscordAccountId",
  "resolveDiscordAccount",
  "resolveDiscordAccountConfig",
  "resolveDiscordChannelId",
  "resolveDiscordComponentAttachmentName",
  "resolveDiscordGroupRequireMention",
  "resolveDiscordGroupToolPolicy",
  "resolveDiscordMaxLinesPerMessage",
  "resolveDiscordPrivilegedIntentsFromFlags",
  "resolveDiscordRuntimeGroupPolicy",
  "resolveDiscordTarget",
  "shouldSuppressLocalDiscordExecApprovalPrompt",
  "tryHandleDiscordMessageActionGuildAdmin",
] as const;

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

    for (const exportName of FORMER_PUBLIC_API_EXPORTS) {
      expect(exportedNames).toContain(exportName);
    }
  });

  itOnSupportedNode("links restored runtime compatibility exports", async () => {
    const api = await import("../api.js");

    for (const exportName of [
      "DISCORD_COMPONENT_CUSTOM_ID_KEY",
      "buildDiscordComponentMessageFlags",
      "createDiscordFormModal",
      "handleDiscordSubagentSpawning",
      "listEnabledDiscordAccounts",
      "resolveDiscordRuntimeGroupPolicy",
      "tryHandleDiscordMessageActionGuildAdmin",
    ]) {
      expect(api).toHaveProperty(exportName);
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
