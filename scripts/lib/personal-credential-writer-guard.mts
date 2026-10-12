import * as ts from "typescript/unstable/ast";
import { SymbolFlags, type Symbol } from "typescript/unstable/sync";
import type { NativeTypeScriptProject } from "./native-typescript.mts";

const accounts = "src/state/user-model-accounts.ts";
const profileMerge = "src/state/user-profiles-merge.ts";
const profileWrites = "src/state/user-profile-writes.worker.ts";
const profileWorker = "src/state/user-profiles.worker.ts";
const authWorker = "src/agents/auth-profiles/store.worker.ts";
const selectionSdk = "src/gateway/model-account-connect.ts";
const githubSecrets = "src/secrets/store/secret-store-hidden-github.kernel.ts";
const key = (file: string, name: string) => `${file}:${name}`;

// Exact edges, not worker-file exemptions: every new entry needs an owner audit.
const callers = new Map<string, readonly string[]>([
  [key(accounts, "writeRecord"), [key(accounts, "writeProfile"), key(accounts, "writeLinks")]],
  [
    key(accounts, "writeProfile"),
    [key(accounts, "updateUserModelAuthProfile"), key(accounts, "connectUserModelAccount")],
  ],
  [
    key(accounts, "writeLinks"),
    [
      "connectUserModelAccount",
      "setUserProfileAuthLink",
      "clearUserProfileAuthLink",
      "mergeUserModelAccounts",
    ].map((name) => key(accounts, name)),
  ],
  [
    key(accounts, "updateUserModelAuthProfile"),
    [
      key(authWorker, "authProfiles.personalReplace"),
      key(authWorker, "authProfiles.personalUsage"),
    ],
  ],
  [
    key(accounts, "connectUserModelAccount"),
    [key(profileWorker, "userProfiles.modelAccount.connect")],
  ],
  [key(accounts, "mergeUserModelAccounts"), [key(profileMerge, "mergeUserProfiles")]],
  [
    key(profileMerge, "mergeUserProfiles"),
    ["mergeProfiles", "linkEmail", "syncGitHubIdentity"].map((name) => key(profileWrites, name)),
  ],
  [key(profileWrites, "mergeProfiles"), [key(profileWorker, "userProfiles.merge")]],
  [key(profileWrites, "linkEmail"), [key(profileWorker, "userProfiles.linkEmail")]],
  [key(profileWrites, "syncGitHubIdentity"), [key(profileWorker, "userProfiles.syncGitHub")]],
  // This private raw upsert relies on its two callers to exclude model-account keys.
  [
    key(githubSecrets, "upsertHiddenGitHubSecret"),
    [
      key(githubSecrets, "writePersonalGitHubSecret"),
      key(githubSecrets, "writeHiddenGitHubSecretInDatabase"),
    ],
  ],
  // Released SDK selection writes preserve credentials and session pins.
  [
    key(accounts, "setUserProfileAuthLink"),
    [
      key(profileWorker, "userProfiles.modelAccount.link"),
      key(selectionSdk, "createModelAccountConnectService/setLinkNative"),
    ],
  ],
  [
    key(accounts, "clearUserProfileAuthLink"),
    [
      key(profileWorker, "userProfiles.modelAccount.unlink"),
      key(selectionSdk, "createModelAccountConnectService/unlink"),
    ],
  ],
]);

// Doctor's caller owns exclusive offline maintenance; no blanket commands/ exemption.
const exclusiveMaintenanceCallers = new Map([
  [
    key(accounts, "renameUserProfileAuthLinks"),
    [
      key(
        "src/commands/doctor-auth-flat-profiles.ts",
        "maybeRepairLegacyAuthProfileStores/migrate",
      ),
    ],
  ],
]);

// Counts shrink freely. An additional sink, even in an existing function, needs review.
const sinks = new Map<string, number>([
  [key(accounts, "writeRecord"), 1],
  [key(accounts, "renameUserProfileAuthLinks"), 1],
  [key(accounts, "mergeUserModelAccounts"), 2],
  // These writers cannot select personal-account rows: team scope or GitHub-only names.
  ...[
    "writeSecretStoreEntriesInDatabase",
    "rollbackSecretStoreEntryWriteInDatabase",
    "updateSecretStoreAllowedHostsInDatabase",
  ].map((name): [string, number] => [key("src/secrets/store/secret-store-write.ts", name), 1]),
  [key("src/secrets/store/secret-store-write.ts", "deleteSecretStoreEntryInDatabase"), 2],
  [
    key(
      "src/secrets/store/secret-store-config-ref.kernel.ts",
      "writeSecretStoreEntryForConfigRefInDatabase",
    ),
    1,
  ],
  [key("src/secrets/store/secret-store-hidden-github.kernel.ts", "writePersonalGitHubSecret"), 1],
  [key("src/secrets/store/secret-store-hidden-github.kernel.ts", "upsertHiddenGitHubSecret"), 1],
  [
    key(
      "src/secrets/store/secret-store-hidden-github.kernel.ts",
      "deleteHiddenGitHubSecretInDatabase",
    ),
    1,
  ],
  [key("src/secrets/store/secret-store-github-handoff.worker.ts", "githubSetup.consume"), 1],
  // Purge removes already-deleted rows and expiring GitHub handoffs, never live credentials.
  [
    key(
      "src/secrets/store/secret-store-expiry.kernel.ts",
      "purgeExpiredSecretStoreEntriesInDatabase",
    ),
    2,
  ],
]);

function operation(node: ts.Node): string {
  const scope: string[] = [];
  let property: string | undefined;
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name) {
      scope.push(parent.name.getText().replace(/^["']|["']$/g, ""));
    }
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer &&
      (ts.isArrowFunction(parent.initializer) || ts.isFunctionExpression(parent.initializer))
    ) {
      scope.push(parent.name.getText());
    }
    if (ts.isPropertyAssignment(parent) && ts.isStringLiteral(parent.name)) {
      property ??= parent.name.text;
    }
  }
  return scope.length ? scope.toReversed().join("/") : (property ?? "<module>");
}

/** Extend the existing worker-ratchet semantic snapshot; no second compiler or runtime guard. */
export function inspectPersonalCredentialWriters(
  sources: readonly { file: string; source: ts.SourceFile }[],
  checker: NativeTypeScriptProject["project"]["checker"],
): string[] {
  const approvedCallers = new Map([...callers, ...exclusiveMaintenanceCallers]);
  const protectedDeclarations = new Map<ts.Node, string>();
  const names = new Set(
    [...approvedCallers.keys()].map((entry) => entry.slice(entry.lastIndexOf(":") + 1)),
  );
  const aliases: [string, string][] = [];
  for (const { file, source } of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const id = key(file, node.name.text);
        if (approvedCallers.has(id)) {
          protectedDeclarations.set(node, id);
        }
      }
      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        aliases.push([node.propertyName?.text ?? node.name.text, node.name.text]);
      }
      if (ts.isNamespaceImport(node)) {
        names.add(node.name.text);
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [from, to] of aliases) {
      if (names.has(from) && !names.has(to)) {
        names.add(to);
        expanded = true;
      }
    }
  }
  const resolved = new Map<Symbol, string[]>();
  const targets = (raw: Symbol | undefined): string[] => {
    if (!raw) {
      return [];
    }
    const symbol = raw.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
    const cached = resolved.get(symbol);
    if (cached) {
      return cached;
    }
    const found: string[] = [];
    resolved.set(symbol, found);
    const declaration = symbol.valueDeclaration?.resolve();
    const direct = declaration && protectedDeclarations.get(declaration);
    if (direct) {
      found.push(direct);
    } else if (symbol.flags & SymbolFlags.Module) {
      for (const member of checker.getExportsOfModule(symbol)) {
        found.push(...targets(member));
      }
    }
    return found;
  };
  const violations: string[] = [];
  const sinkCounts = new Map<string, number>();
  const edgeCounts = new Map<string, number>();
  for (const { file, source } of sources) {
    const fail = (node: ts.Node, reason: string) => {
      violations.push(
        `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${reason}`,
      );
    };
    const references: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isTypeNode(node) ||
        ts.isImportDeclaration(node) ||
        ((ts.isExportDeclaration(node) || ts.isExportSpecifier(node)) && node.isTypeOnly)
      ) {
        return;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["insertInto", "updateTable", "deleteFrom"].includes(node.expression.name.text)
      ) {
        let table = node.arguments[0];
        if (table && ts.isIdentifier(table)) {
          const declaration = checker.getSymbolAtLocation(table)?.valueDeclaration?.resolve();
          if (declaration && ts.isVariableDeclaration(declaration)) {
            table = declaration.initializer;
          }
        }
        if (table && ts.isStringLiteralLikeNode(table) && table.text === "secret_store_entries") {
          const id = key(file, operation(node));
          const count = (sinkCounts.get(id) ?? 0) + 1;
          sinkCounts.set(id, count);
          if (count > (sinks.get(id) ?? 0)) {
            fail(
              node,
              "unreviewed secret_store_entries writer; enter the personal credential owner or audit a nonpersonal/maintenance exclusion",
            );
          }
        }
      }
      if (
        (ts.isStringLiteralLikeNode(node) || ts.isTemplateHead(node)) &&
        /\b(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from)\s+["`[]?secret_store_entries\b/i.test(
          node.text,
        )
      ) {
        fail(node, "raw secret_store_entries write bypasses the reviewed credential sinks");
      }
      if (
        (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
        (names.has(node.text) ||
          (ts.isExportDeclaration(node.parent) &&
            node.parent.moduleSpecifier === node &&
            (!node.parent.exportClause || ts.isNamespaceExport(node.parent.exportClause))) ||
          (ts.isCallExpression(node.parent) &&
            node.parent.expression.kind === ts.SyntaxKind.ImportKeyword)) &&
        !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node) &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      ) {
        references.push(node);
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
    const symbols = checker.getSymbolAtLocation(references);
    for (const [index, node] of references.entries()) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : symbols[index];
      const guarded = targets(symbol);
      if (!guarded.length) {
        continue;
      }
      // A namespace's static member is checked at that member; escaping the namespace is denied.
      if (
        (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) ||
        (ts.isElementAccessExpression(node.parent) &&
          node.parent.expression === node &&
          ts.isStringLiteral(node.parent.argumentExpression))
      ) {
        continue;
      }
      const expression =
        (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
        (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
          ? node.parent
          : node;
      const directCall =
        ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
      for (const target of guarded) {
        const caller = key(file, operation(node));
        const edge = `${target}<-${caller}`;
        const count = (edgeCounts.get(edge) ?? 0) + 1;
        edgeCounts.set(edge, count);
        if (!directCall || !approvedCallers.get(target)?.includes(caller) || count > 1) {
          fail(node, `unreviewed personal credential writer reference to ${target} from ${caller}`);
        }
      }
    }
  }
  return [...new Set(violations)].toSorted();
}
