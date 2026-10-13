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
const publicationWorker = "src/state/github-publication.worker.ts";
const publicationRequestWorker = "src/state/github-publication-request.worker.ts";
const sharedPublication = "src/gateway/github-publication-store.worker.ts";
const personalPublication = "src/gateway/github-personal-publication-store.worker.ts";
const repositoryPublication = "src/gateway/github-repository-publication-store.worker.ts";
const publicationLifecycle = "src/state/github-publication-session-lifecycles.worker.ts";
const publicationDeletion = "src/state/github-personal-publication-lifecycle.ts";
const authCells = "src/agents/auth-profiles/sqlite-json-write.ts";
const authRelocation = "src/infra/state-migrations.shared-auth-store.ts";
const machineState = "src/state/config-machine-state-write.ts";
const credentialAuthority = "src/state/user-model-account-authority.ts";
const credentialCustody = "src/agents/auth-profiles/credential-write-custody.ts";
const guardedTables = new Set([
  "secret_store_entries",
  "auth_profile_store",
  "config_machine_state",
  "github_publication_requests",
  "github_personal_publication_requests",
  "github_repository_publication_requests",
  "github_publication_session_lifecycles",
]);

// Schema owners create/rebuild tables and v18 adds a column; no publication row-DML exception.
const publicationWriters = new Map<string, readonly string[]>([
  [
    key(publicationLifecycle, "insertGitHubPublicationSessionLifecycle"),
    [
      key(sharedPublication, "insertGitHubPublicationRequest"),
      key(personalPublication, "insertPersonalGitHubPublicationInDatabase"),
    ],
  ],
  ...(
    [
      [sharedPublication, "insertGitHubPublicationRequest"],
      [personalPublication, "insertPersonalGitHubPublicationInDatabase"],
      [repositoryPublication, "insertRepositoryGitHubPublicationInDatabase"],
    ] as const
  ).map(([file, name]): [string, string[]] => [
    key(file, name),
    [key(publicationRequestWorker, "githubPublications.insert/write")],
  ]),
  ...[
    "markSharedGitHubPublicationReportedInDatabase",
    "claimGitHubPublicationExecutionInDatabase",
    "deferGitHubPublicationRequestsInDatabase",
    "bindAcceptedGitHubPublicationClaimSnapshotInDatabase",
  ].map((name): [string, string[]] => [
    key(sharedPublication, name),
    [key(publicationWorker, "sharedMutation")],
  ]),
  [
    key(sharedPublication, "writeGitHubPublicationExecutionInDatabase"),
    [key(sharedPublication, "createGitHubPublicationExecutionStoreInDatabase")],
  ],
  ...[
    "claimPersonalGitHubPublicationInDatabase",
    "writePersonalGitHubPublicationInDatabase",
    "requirePersonalGitHubPublicationConfirmationInDatabase",
    "markPersonalGitHubPublicationReportedInDatabase",
  ].map((name): [string, string[]] => [
    key(personalPublication, name),
    [key(publicationWorker, "personalMutation")],
  ]),
  ...[
    "bindRepositoryGitHubPublicationCheckpointInDatabase",
    "failRepositoryGitHubPublicationPreparationInDatabase",
    "writeRepositoryGitHubPublicationInDatabase",
    "claimRepositoryGitHubPublicationInDatabase",
    "markRepositoryGitHubPublicationReportedInDatabase",
    "failStaleRepositoryGitHubPublicationInDatabase",
    "deferRepositoryGitHubPublicationClaimsInDatabase",
  ].map((name): [string, string[]] => [
    key(repositoryPublication, name),
    [key(publicationWorker, "repositoryMutation")],
  ]),
]);

// Exact edges, not worker-file exemptions: every new entry needs an owner audit.
const callers = new Map<string, readonly string[]>([
  ...publicationWriters,
  [
    key(credentialCustody, "withAuthProfileCredentialWriteCustody"),
    [
      key(credentialAuthority, "withAuthProfileCredentialWrite"),
      key(
        "src/agents/auth-profiles/store.ts",
        "createAuthProfileStoreRuntime/saveAuthProfileStore",
      ),
    ],
  ],
  [
    key(credentialAuthority, "withAuthProfileCredentialWrite"),
    [
      key(authCells, "writeAuthProfileJsonCell"),
      key(authCells, "deleteAuthProfileJsonCell"),
      key(machineState, "publishMachineStateWrite"),
    ],
  ],
  [
    key(machineState, "publishMachineStateWrite"),
    [
      "upsertConfigMachineState",
      "updateConfigMachineStateInDatabase",
      "deleteConfigMachineState",
      "importConfigMachineState",
    ].map((name) => key(machineState, name)),
  ],
  ...["shared", "personal", "repository"].map((kind): [string, string[]] => [
    key(publicationWorker, `${kind}Mutation`),
    [
      key(publicationWorker, `githubPublications.${kind}`),
      key(publicationWorker, "githubPublications.maintenance"),
    ],
  ]),
  [
    key(sharedPublication, "createGitHubPublicationExecutionStoreInDatabase"),
    [key(publicationWorker, "sharedMutation")],
  ],
  [
    key(publicationDeletion, "deletePersonalGitHubSessionReceiptsInDatabase"),
    [key("src/state/openclaw-state-worker-runtime.ts", "executeSharedStateCommand")],
  ],
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
  // Canonical auth sinks publish before releasing authority; state-only writes do not revoke.
  [key(authCells, "writeAuthProfileJsonCell"), 2],
  [key(authCells, "deleteAuthProfileJsonCell"), 2],
  // Exclusive stopped-owner relocation copies the shared row and then removes its source.
  [key(authRelocation, "copyRowsToState"), 1],
  [key(authRelocation, "cleanupSourceRows"), 1],
  // Generic entry points publish the protected key through the credential owner.
  ...[
    "upsertConfigMachineState",
    "updateConfigMachineStateInDatabase",
    "deleteConfigMachineState",
    "importConfigMachineState",
  ].map((name): [string, number] => [key(machineState, name), 1]),
  // These dynamic keys are bounded by their owning reader/producer, not by TypeScript literals.
  [
    key(
      "src/commands/doctor-session-incognito-key-repair-state.ts",
      "rewriteSharedStateSessionKeys",
    ),
    1,
  ],
  [key("src/infra/state-migrations.node-host.ts", "migrateIntoDatabase"), 1],
  [key("src/infra/state-migrations.tui-last-session.ts", "migrateLegacyTuiLastSessions"), 2],
  [key("src/gateway/mention-inbox-store.worker.ts", "writeMentionStoreChanges/writeValue"), 1],
  [key("src/gateway/mention-inbox-store.worker.ts", "writeMentionStoreChanges/flushDeletes"), 1],
  ...[...publicationWriters.keys()].map((id): [string, number] => [id, 1]),
  [key(publicationDeletion, "deletePersonalGitHubSessionReceiptsInDatabase"), 2],
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

const rawMachineStateSinks = new Map([
  [key("src/state/openclaw-state-db-schema-v12-foldin.ts", "migrateSingletonStateFoldInV12"), 1],
  [key("src/state/openclaw-state-db-schema-v13-widerow.ts", "migrateJsonCanonicalWideRowsV13"), 2],
]);

function mayWriteAuthMachineState(
  node: ts.CallExpression,
  checker: NativeTypeScriptProject["project"]["checker"],
): boolean {
  const mayIncludeAuthKey = (value: ts.Node): boolean => {
    if (ts.isArrayLiteralExpression(value)) {
      return value.elements.some(mayIncludeAuthKey);
    }
    const type = checker.getTypeAtLocation(value);
    const variants = type.isUnionType() ? type.getTypes() : [type];
    return variants.some((variant) =>
      variant.isStringLiteralType() ? variant.value === "authProfiles.store" : true,
    );
  };
  let selected = true;
  let changesKey = false;
  let query: ts.Node = node;
  while (ts.isPropertyAccessExpression(query.parent) && ts.isCallExpression(query.parent.parent)) {
    const call = query.parent.parent;
    const method = query.parent.name.text;
    if (method === "values" || method === "set") {
      const values = call.arguments[0];
      const property =
        values && ts.isObjectLiteralExpression(values)
          ? values.properties.find(
              (entry) =>
                ts.isPropertyAssignment(entry) &&
                (ts.isIdentifier(entry.name) || ts.isStringLiteralLikeNode(entry.name)) &&
                entry.name.text === "state_key",
            )
          : undefined;
      if (property && ts.isPropertyAssignment(property)) {
        if (method === "set") {
          changesKey ||= mayIncludeAuthKey(property.initializer);
        } else {
          selected = mayIncludeAuthKey(property.initializer);
        }
      }
    } else if (
      method === "where" &&
      call.arguments[0] &&
      ts.isStringLiteralLikeNode(call.arguments[0]) &&
      call.arguments[0].text === "state_key" &&
      call.arguments[1] &&
      ts.isStringLiteralLikeNode(call.arguments[1]) &&
      ["=", "in"].includes(call.arguments[1].text) &&
      call.arguments[2]
    ) {
      selected &&= mayIncludeAuthKey(call.arguments[2]);
    }
    query = call;
  }
  return selected || changesKey;
}

const repeatedEdges = new Map([
  [
    `${key(sharedPublication, "createGitHubPublicationExecutionStoreInDatabase")}<-${key(publicationWorker, "sharedMutation")}`,
    3,
  ],
  ...["shared", "repository"].map((kind): [string, number] => [
    `${key(publicationWorker, `${kind}Mutation`)}<-${key(publicationWorker, "githubPublications.maintenance")}`,
    2,
  ]),
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
  return [property, ...scope.toReversed()].filter(Boolean).join("/") || "<module>";
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
  const rawSinkCounts = new Map<string, number>();
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
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteralLikeNode(node.name)) &&
        node.name.text === "type"
      ) {
        const type = checker.getTypeAtLocation(node.initializer);
        const variants = type.isUnionType() ? type.getTypes() : [type];
        if (
          variants.some(
            (value) => value.isStringLiteralType() && value.value === "machineState.write",
          ) &&
          key(file, operation(node)) !==
            key("src/state/config-machine-state-async.ts", "writeConfigMachineStateAsync")
        ) {
          fail(node, "machine-state credential writes require the host publication adapter");
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["insertInto", "updateTable", "deleteFrom"].includes(node.expression.name.text)
      ) {
        let table = node.arguments[0];
        const seen = new Set<ts.Node>();
        while (table && !seen.has(table)) {
          seen.add(table);
          if (ts.isIdentifier(table)) {
            const declaration = checker.getSymbolAtLocation(table)?.valueDeclaration?.resolve();
            if (declaration && ts.isVariableDeclaration(declaration)) {
              const loop = declaration.parent.parent;
              table =
                declaration.initializer ?? (ts.isForOfStatement(loop) ? loop.expression : table);
              continue;
            }
          } else if (ts.isAsExpression(table) || ts.isParenthesizedExpression(table)) {
            table = table.expression;
            continue;
          } else if (
            ts.isCallExpression(table) &&
            ts.isPropertyAccessExpression(table.expression) &&
            table.expression.name.text === "filter"
          ) {
            // noLib snapshots cannot infer Array.filter; its source still bounds the table set.
            table = table.expression.expression;
            continue;
          }
          break;
        }
        const tableType =
          (!table || !ts.isStringLiteralLikeNode(table)) && node.arguments[0]
            ? checker.getTypeAtLocation(node.arguments[0])
            : undefined;
        const tables =
          table && ts.isStringLiteralLikeNode(table)
            ? [table.text]
            : table && ts.isArrayLiteralExpression(table)
              ? table.elements.filter(ts.isStringLiteralLikeNode).map((element) => element.text)
              : (tableType?.isUnionType() ? tableType.getTypes() : tableType ? [tableType] : [])
                  .filter((type) => type.isStringLiteralType())
                  .map((type) => type.value);
        const guarded = tables.filter(
          (name) =>
            guardedTables.has(name) &&
            (name !== "config_machine_state" || mayWriteAuthMachineState(node, checker)),
        );
        if (guarded.length) {
          const id = key(file, operation(node));
          const count = (sinkCounts.get(id) ?? 0) + 1;
          sinkCounts.set(id, count);
          if (count > (sinks.get(id) ?? 0)) {
            fail(
              node,
              `unreviewed ${guarded.join("/")} writer; enter the authority owner or audit a maintenance exclusion`,
            );
          }
        }
      }
      if (ts.isStringLiteralLikeNode(node) || ts.isTemplateHead(node)) {
        const writes = node.text.matchAll(
          /\b(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from)\s+["`[]?(secret_store_entries|auth_profile_store|config_machine_state|github_(?:(?:personal_|repository_)?publication_requests|publication_session_lifecycles))\b/gi,
        );
        for (const write of writes) {
          const id = key(file, operation(node));
          const count = (rawSinkCounts.get(id) ?? 0) + 1;
          rawSinkCounts.set(id, count);
          if (
            write[1]?.toLowerCase() !== "config_machine_state" ||
            count > (rawMachineStateSinks.get(id) ?? 0)
          ) {
            fail(node, "raw authority-table write bypasses the reviewed writer sinks");
          }
        }
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
        if (
          !directCall ||
          !approvedCallers.get(target)?.includes(caller) ||
          count > (repeatedEdges.get(edge) ?? 1)
        ) {
          const owner = target.includes("publication")
            ? "GitHub publication"
            : "personal credential";
          fail(node, `unreviewed ${owner} writer reference to ${target} from ${caller}`);
        }
      }
    }
  }
  return [...new Set(violations)].toSorted();
}
