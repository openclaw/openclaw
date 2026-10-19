import path from "node:path";
import * as ts from "typescript/ast";
import { serverFS } from "typescript/fs";
import { SymbolFlags, type Symbol } from "typescript/sync";
import { createNativeTypeScriptProject } from "./native-typescript.mts";
import { inspectPersonalCredentialWriters } from "./personal-credential-writer-guard.mts";

// Each entry is a reviewed, released compatibility boundary, not a whole-file exemption.
// Kernels may join this list only after their bundled callers have moved to workers.
const reviewed = new Map<string, readonly string[]>([
  ["src/agents/agent-tools.ts", ["createOpenClawCodingToolsInternal", "createOpenClawCodingTools"]],
  ["src/agents/openclaw-tools.ts", ["createOpenClawTools"]],
  ["src/state/user-profile-list.native.ts", ["hasMultipleSessionSharingIdentitiesNative"]],
  [
    "src/plugin-sdk/sqlite-runtime-legacy.ts",
    [
      "sdkOpenOpenClawAgentDatabase",
      "sdkBorrowOpenClawAgentDatabase",
      "sdkWithOpenClawAgentDatabaseAsync",
      "sdkWithOpenClawAgentDatabaseWrite",
      "sdkRunOpenClawAgentWriteAdmission",
      "sdkExecuteSqliteQueryTakeFirstSync",
      "sdkIterateSqliteQuerySync",
      "sdkPrepareSqliteQuerySync",
      "sdkRunSqliteImmediateTransaction",
    ],
  ],
  [
    "src/sessions/session-upstream-links.ts",
    ["deleteSessionUpstreamLink", "upsertSessionUpstreamLink"],
  ],
  ["src/sessions/stored-model-overrides.ts", ["resolveStoredModelOverride"]],
  [
    "src/gateway/session-catalog-identity.ts",
    ["createSessionCatalogSourceActorProjector", "createSessionCatalogGitHubLinker"],
  ],
  [
    "src/plugin-sdk/memory-core-host-engine-sessions.ts",
    ["loadArchivedSessions", "loadMemorySessionMetadata", "resolveMemorySessionTargets"],
  ],
  [
    "src/plugin-sdk/codex-session-transcript-runtime.ts",
    [
      "validateCodexSessionTranscriptReadAdmission",
      "validateCodexSessionTranscriptContextVersion",
      "withCodexSessionTranscriptMirrorWriteLock",
    ],
  ],
  [
    "src/plugin-sdk/session-transcript-runtime.ts",
    ["withSessionTranscriptWriteLock", "readSessionTranscriptCatalogTitle"],
  ],
  [
    "src/plugin-sdk/session-store-runtime.ts",
    [
      "getConversationSession",
      "readSessionStoreTranscriptStatsSync",
      "readAmbientTranscriptWatermark",
    ],
  ],
  ["src/plugin-sdk/session-transcript-hit.ts", ["loadCombinedSessionStoreForGateway"]],
  ["src/plugin-sdk/provider-selection-runtime.ts", ["resolveConfiguredCapabilityProvider"]],
  ["src/pairing/pairing-store.ts", ["readChannelAllowFromStoreSync"]],
  ["src/media-generation/runtime-shared.ts", ["resolveCapabilityModelCandidates"]],
  ["src/talk/provider-resolver.ts", ["resolveConfiguredRealtimeVoiceProvider"]],
  ["src/auto-reply/commands-registry.ts", ["resolveCommandArgMenu"]],
  [
    "src/channels/direct-dm-access.ts",
    ["resolveInboundDirectDmAccessWithRuntime", "createPreCryptoDirectDmAuthorizer"],
  ],
  ["src/channels/direct-dm.ts", ["dispatchInboundDirectDmWithRuntime"]],
  ["src/channels/session-envelope.ts", ["resolveInboundSessionEnvelopeContext"]],
  [
    "src/channels/inbound-event/envelope.ts",
    [
      "createInboundEnvelopeBuilder",
      "resolveInboundRouteEnvelopeBuilder",
      "resolveInboundRouteEnvelopeBuilderWithRuntime",
    ],
  ],
  ["src/security/dm-policy-shared.ts", ["resolveDmGroupAccessWithLists"]],
  [
    "src/infra/outbound/account-scoped-conversation-bindings.ts",
    ["createAccountScopedConversationBindingManager"],
  ],
  [
    "extensions/imessage/src/conversation-bindings.ts",
    ["createIMessageConversationBindingManager"],
  ],
  ["extensions/matrix/auth-presence.ts", ["hasAnyMatrixAuth"]],
  [
    "src/agents/harness/native-session/binding-lifecycle.ts",
    ["createNativeSessionBindingLifecycle"],
  ],
  [
    "src/agents/harness/native-session/binding-generation.ts",
    [
      "resolveNativeSessionBinding",
      "reclaimNativeSessionGeneration",
      "captureNativeSessionGenerationAuthority",
    ],
  ],
  [
    "src/agents/harness/native-session/binding-authority.ts",
    ["createNativeSessionBindingAuthority", "combineNativeSessionBindingAuthority"],
  ],
  [
    "src/agents/harness/native-session/binding-generation-authority.ts",
    ["prepareNativeSessionGenerationAuthority", "resolveNativeSessionBindingWithAuthority"],
  ],
]);

// Mixed SDK receivers retain only these deprecated members, never their live factories.
const reviewedMembers = new Map<string, readonly string[]>([
  [
    "src/agents/sessions/session-manager.ts",
    ["open", "openBounded", "openDetachedBounded", "openModelContext", "readSessionContext"],
  ],
  [
    "src/agents/sessions/session-manager-core.ts",
    ["setSessionTarget", "reloadPersistedTranscript"],
  ],
  [
    "src/agents/harness/native-session/initialization.ts",
    ["createNativeSessionInitializationOwner.prepare.link"],
  ],
  [
    "src/infra/outbound/account-scoped-conversation-bindings.ts",
    ["createAccountBindingManager.listBySession", "createAccountBindingManager.touch"],
  ],
  [
    "src/agents/harness/host-capability.ts",
    ["createAgentHarnessHostCapabilities.createToolSurface"],
  ],
  [
    "src/gateway/model-account-connect.ts",
    [
      "createModelAccountConnectService.listLinks",
      "createModelAccountConnectService.link",
      "createModelAccountConnectService.unlink",
      "createModelAccountConnectService.list",
      "createModelAccountConnectService.select",
      "createModelAccountConnectService.status",
      "createModelAccountConnectService.cancel",
    ],
  ],
  [
    "src/infra/outbound/session-binding-service.ts",
    [
      "DEFAULT_SESSION_BINDING_SERVICE.listBySession",
      "DEFAULT_SESSION_BINDING_SERVICE.resolveByConversation",
    ],
  ],
  [
    "src/plugin-state/plugin-state-store.legacy.ts",
    [
      "createSyncKeyedStore.lookupMany",
      "createSyncKeyedStore.consume",
      "createSyncKeyedStore.clear",
    ],
  ],
]);

// These are candidates, not exemptions: every value reference must resolve to
// another proven candidate or an inventory-reviewed worker/maintenance entry.
const nonRuntimeCandidates = new Map<string, readonly string[]>([
  ["src/state/openclaw-state-db-maintenance.ts", ["writeCurrentStateSchemaMetadata"]],
  ["src/state/user-profile-mutation.ts", ["runUserProfileWriteTransaction"]],
  ["src/gateway/channel-operator-authority.ts", ["resolveChannelOperatorIdentityFacts"]],
  [
    "src/state/user-profile-identity.read.ts",
    [
      "selectHasMultipleSessionSharingIdentities",
      "selectUserProfileIdentityInDatabase",
      "selectUserProfileDisplaysInDatabase",
      "readUserProfileSnapshotCommand",
    ],
  ],
  [
    "src/state/user-profiles-internal.ts",
    [
      "selectUserProfileEmails",
      "selectProfileDisplayEntries",
      "selectResolvedUserProfile",
      "selectResolvedUserProfileById",
      "selectResolvedUserProfileMetadataById",
      "requireResolvedUserProfileMetadataById",
      "requireResolvedUserProfileById",
      "selectProfileAvatarMetadata",
      "inspectProfileAvatarInDatabase",
      "readUserProfileAvatarCommand",
    ],
  ],
  [
    "src/state/user-profile-list.native.ts",
    ["getUserProfileDisplaysNative", "readUserProfileAliasesNative"],
  ],
  [
    "src/state/user-channel-identities.ts",
    ["resolveUserChannelIdentityInDatabase", "resolveUserChannelIdentity"],
  ],
  [
    "src/state/user-profiles-schema.ts",
    ["ensureUserProfilesSchema", "ensureUserProfileRoleSchema"],
  ],
  [
    "src/state/user-profiles.ts",
    [
      "ensureProfileForEmailWithInitialName",
      "ensureProfileForEmail",
      "ensureGatewayOwnerProfile",
      "ensureProfileForTailscaleIdentity",
    ],
  ],
  [
    "src/state/user-profile-list.ts",
    ["stageUserProfileCatalogChange", "publishUserProfilesChange"],
  ],
  [
    "src/state/user-profile-github-identity.ts",
    [
      "selectStoredGitHubIdentities",
      "selectProfileAccessEntries",
      "selectUserProfileGitHubIdentities",
      "resolveCachedGitHubIdentityInDatabase",
      "readUserProfileGitHubCommand",
    ],
  ],
]);

// These one-shot owners retain the identity callback only in their returned CLI authority.
const nonRuntimeMemberForwards = new Map([
  [
    "src/gateway/channel-operator-authority.ts",
    [
      {
        caller: "resolveChannelOperatorAdminAuthority",
        member: "resolveChannelOperatorIdentityFacts.isCurrent",
        receiver: "captureLinkedOperatorAdmin",
        argument: 2,
      },
      {
        caller: "resolveUpdateChannelOperatorAdminIdentityAuthority",
        member: "resolveChannelOperatorIdentityFacts.isCurrent",
        receiver: "captureLinkedOperatorAdminIdentity",
        argument: 2,
      },
    ],
  ],
]);

// These exact declarations consume their inline callbacks synchronously.
const synchronousScopes = new Map<string, ReadonlyMap<string, number>>([
  [
    "src/agents/subagents/spawn/subagent-session-store-legacy.ts",
    new Map([["withLegacySessionCapabilityRead", 0]]),
  ],
  [
    "src/config/sessions/session-accessor.sqlite-participants.native.ts",
    new Map([["recordSessionParticipantWithAliasRead", 2]]),
  ],
  [
    "src/plugin-state/plugin-state-store.sqlite.ts",
    new Map([
      ["readPluginState", 2],
      ["writePluginState", 2],
    ]),
  ],
  [
    "src/state/openclaw-state-db-readonly.ts",
    new Map([["withExistingOpenClawStateDatabaseReadOnly", 0]]),
  ],
  ["src/state/openclaw-state-db.ts", new Map([["runOpenClawStateWriteTransaction", 0]])],
  ["src/state/user-profile-mutation.ts", new Map([["runUserProfileWriteTransaction", 0]])],
  ["src/state/user-profiles-internal.ts", new Map([["readResolvedUserProfile", 1]])],
  [
    "src/infra/sqlite-transaction.ts",
    new Map([
      ["runSqliteDeferredTransactionSync", 1],
      ["runSqliteReadSnapshotSync", 1],
    ]),
  ],
  [
    "src/plugins/runtime/generation-state.ts",
    new Map([["withPluginRuntimeGenerationRegistryScope", 1]]),
  ],
  [
    "src/agents/harness/host-capability.ts",
    new Map([["createAgentHarnessHostCapabilities.withToolConstructionScope", 0]]),
  ],
  ["src/infra/state-database-maintenance.ts", new Map([["withStateDatabaseSchemaMaintenance", 1]])],
  [
    "src/state/openclaw-state-db-maintenance.ts",
    new Map([["runStateSchemaMigrationTransaction", 2]]),
  ],
]);

type NonRuntimeTier = "T2" | "T3" | "W";

type BoundaryOperation = {
  file: string;
  name: string;
  valid: boolean;
  reviewed: boolean;
  candidate: boolean;
  nonRuntimeValid: boolean;
  entries: Set<NonRuntimeTier>;
  node:
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.ClassDeclaration;
};

/** Prove compatibility and maintenance kernels from their complete value-reference graph. */
export function inspectDatabaseWorkerBoundaries(
  root: string,
  sourceTexts: ReadonlyMap<string, string>,
  isNonRuntime: (file: string, operation: string) => boolean = (file) =>
    /\.worker\.[cm]?[jt]s$/.test(file),
  classifyEntry: (file: string, operation: string) => NonRuntimeTier | undefined = () => undefined,
  validateCredentialWriters = true,
): {
  operations: Map<string, Set<string>>;
  callLocations: Map<string, Set<string>>;
  nonRuntimeOperations: Map<string, Map<string, NonRuntimeTier>>;
  nonRuntimeCallLocations: Map<string, Set<string>>;
  violations: string[];
} {
  const operations = new Map<string, Set<string>>();
  const callLocations = new Map<string, Set<string>>();
  const nonRuntimeOperations = new Map<string, Map<string, NonRuntimeTier>>();
  const nonRuntimeCallLocations = new Map<string, Set<string>>();
  const violations: string[] = [];
  if (sourceTexts.size === 0) {
    return { operations, callLocations, nonRuntimeOperations, nonRuntimeCallLocations, violations };
  }
  const config = ".openclaw-database-worker-compat.tsconfig.json";
  const files = Object.fromEntries(sourceTexts);
  // Keep historical snapshots hermetic, but preserve member identities through
  // Required<T>: without this standard mapped type, noLib erases those receivers.
  const globals = ".openclaw-database-worker-compat.globals.d.ts";
  files[globals] = "type Required<T> = { [P in keyof T]-?: T[P] };";
  files[config] = JSON.stringify({
    compilerOptions: {
      allowJs: true,
      noLib: true,
      types: [],
      target: "esnext",
      module: "nodenext",
      moduleResolution: "nodenext",
      jsx: "preserve",
      paths: {
        "openclaw/plugin-sdk": ["./src/plugin-sdk/index.ts"],
        "openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"],
        "@openclaw/plugin-sdk": ["./src/plugin-sdk/index.ts"],
        "@openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"],
      },
    },
    files: [...sourceTexts.keys(), globals],
    include: [],
  });
  // The supplied snapshot owns all source bytes, including historical comparisons.
  using session = createNativeTypeScriptProject({
    cwd: root,
    configFileName: config,
    files,
    fs: {
      readFile: () => undefined,
      fileExists: () => false,
      directoryExists: () => false,
      getAccessibleEntries: () => ({ files: [], directories: [], symlinks: undefined }),
      realpath: serverFS.identity,
      stat: serverFS.fakeStat,
      writeFile: serverFS.error,
      removeFile: serverFS.error,
    },
  });
  const { checker, program } = session.project;
  const forwarded = new Map<Symbol, Symbol>();
  // Compiler aliases are immutable; prepared binding overrides are applied separately.
  const aliasTargets = new Map<Symbol, Symbol>();
  const resolveSymbol = (symbol: Symbol | undefined): Symbol | undefined => {
    let target = symbol;
    if (symbol && symbol.flags & SymbolFlags.Alias) {
      target = aliasTargets.get(symbol);
      if (!target) {
        target = checker.getAliasedSymbol(symbol);
        aliasTargets.set(symbol, target);
      }
    }
    return target && (forwarded.get(target) ?? target);
  };
  const operationName = (node: ts.Node) => {
    const parts: string[] = [];
    for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
      if (
        (ts.isFunctionDeclaration(parent) ||
          ts.isFunctionExpression(parent) ||
          ts.isMethodDeclaration(parent)) &&
        parent.name &&
        ts.isIdentifier(parent.name)
      ) {
        parts.unshift(parent.name.text);
      } else if (
        (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
        parent.initializer &&
        (ts.isArrowFunction(parent.initializer) ||
          ts.isFunctionExpression(parent.initializer) ||
          (ts.isVariableDeclaration(parent) &&
            ts.isObjectLiteralExpression(parent.initializer) &&
            ts.isVariableDeclarationList(parent.parent) &&
            ts.isVariableStatement(parent.parent.parent) &&
            ts.isSourceFile(parent.parent.parent.parent))) &&
        ts.isIdentifier(parent.name)
      ) {
        parts.unshift(parent.name.text);
      }
    }
    return parts.join(".");
  };
  const isInlineInvocation = (node: ts.Node): boolean => {
    const call = node.parent;
    if (!ts.isCallExpression(call)) {
      return false;
    }
    if (call.expression === node) {
      return true;
    }
    const symbol = resolveSymbol(checker.getSymbolAtLocation(call.expression));
    const declaration = symbol?.valueDeclaration?.resolve();
    const callable =
      declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
    if (!callable || !(ts.isFunctionDeclaration(callable) || ts.isArrowFunction(callable))) {
      return false;
    }
    const file = path.relative(root, callable.getSourceFile().fileName).split(path.sep).join("/");
    const argument = synchronousScopes.get(file)?.get(operationName(callable));
    return argument !== undefined && call.arguments[argument] === node;
  };
  const registered = new Map<Symbol, BoundaryOperation>();
  const declarations = new Map<ts.Node, BoundaryOperation>();
  const contractDeclarations = new Map<ts.Node, BoundaryOperation>();
  const declarationNames = new Set<ts.Node>();
  const families = new Map<BoundaryOperation, Set<BoundaryOperation>>();
  const names = new Set(
    [...reviewed.values(), ...reviewedMembers.values(), ...nonRuntimeCandidates.values()]
      .flat()
      .map((name) => name.split(".").at(-1)!),
  );
  const boundaryName = (node: BoundaryOperation["node"]) =>
    ts.isArrowFunction(node) && ts.isPropertyAssignment(node.parent)
      ? node.parent.name
      : "name" in node
        ? node.name
        : undefined;
  const sources = [...sourceTexts.keys()].map((file) => {
    const source = program.getSourceFile(path.resolve(root, file));
    if (!source) {
      throw new Error(`Compatibility scan did not load ${file}`);
    }
    for (const name of [
      ...(reviewed.get(file) ?? []),
      ...(nonRuntimeCandidates.get(file) ?? []),
      ...(reviewedMembers.get(file) ?? []),
    ]) {
      let node: BoundaryOperation["node"] | undefined = source.statements.find(
        (statement): statement is ts.FunctionDeclaration | ts.ClassDeclaration =>
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === name &&
          (ts.isClassDeclaration(statement) || Boolean(statement.body)),
      );
      const member = reviewedMembers.get(file)?.includes(name);
      if (member) {
        const findMember = (child: ts.Node) => {
          if (
            (ts.isMethodDeclaration(child) ||
              (ts.isArrowFunction(child) && ts.isPropertyAssignment(child.parent))) &&
            operationName(child) === name
          ) {
            node = child;
          }
          child.forEachChild(findMember);
        };
        source.forEachChild(findMember);
      }
      const nameNode = node && boundaryName(node);
      if (!node || !nameNode) {
        continue;
      }
      const symbol = resolveSymbol(checker.getSymbolAtLocation(nameNode));
      if (!symbol) {
        throw new Error(`Compatibility scan could not resolve ${file}:${name}`);
      }
      const candidate = nonRuntimeCandidates.get(file)?.includes(name) ?? false;
      const valid =
        candidate || checker.getJsDocTagsOfSymbol(symbol).some((tag) => tag.name === "deprecated");
      if (!valid) {
        violations.push(`${file}:${name}: reviewed compatibility operation must be @deprecated`);
      }
      const operation: BoundaryOperation = {
        file,
        name,
        valid,
        reviewed: true,
        candidate,
        nonRuntimeValid: true,
        entries: new Set(),
        node,
      };
      registered.set(symbol, operation);
      const object = ts.isMethodDeclaration(operation.node)
        ? operation.node.parent
        : ts.isArrowFunction(operation.node) && ts.isPropertyAssignment(operation.node.parent)
          ? operation.node.parent.parent
          : undefined;
      if (member && object && ts.isObjectLiteralExpression(object)) {
        // Explicit receiver types create distinct symbols at each instantiation.
        // Match their member declaration, never the spelling on unrelated stores.
        const contract = checker.getContextualType(object)?.getProperty(nameNode.getText());
        if (contract) {
          forwarded.set(contract, symbol);
          for (const declaration of contract.declarations) {
            const resolved = declaration.resolve();
            if (resolved) {
              contractDeclarations.set(resolved, operation);
            }
          }
        }
      }
      declarations.set(node, operation);
      declarationNames.add(nameNode);
    }
    return { file, source };
  });
  if (validateCredentialWriters) {
    violations.push(...inspectPersonalCredentialWriters(sources, checker));
  }
  // Follow named kernels from the reviewed boundaries. A symbol reference from
  // outside this closure (or an escaped callback) will make that kernel live.
  // A returned receiver exists only through its factory. Keep its methods in
  // the same reachability family; a live factory or escaped member retires it.
  const addMember = (owner: BoundaryOperation, node: BoundaryOperation["node"]) => {
    let member = declarations.get(node);
    if (!member) {
      member = {
        file: owner.file,
        name: operationName(node),
        valid: true,
        reviewed: false,
        candidate: false,
        nonRuntimeValid: true,
        entries: new Set(),
        node,
      };
      declarations.set(node, member);
      const name =
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        ts.isPropertyAssignment(node.parent)
          ? node.parent.name
          : "name" in node
            ? node.name
            : undefined;
      if (name) {
        declarationNames.add(name);
      }
      const symbol = name ? resolveSymbol(checker.getSymbolAtLocation(name)) : undefined;
      if (symbol) {
        registered.set(symbol, member);
        if (name && ts.isIdentifier(name)) {
          names.add(name.text);
        }
      }
    }
    // An explicitly reviewed member has its own compatibility boundary even
    // when its factory also creates live async methods.
    if (!member.reviewed) {
      const family = families.get(owner) ?? new Set<BoundaryOperation>();
      family.add(member);
      families.set(owner, family);
    }
    return member;
  };
  const primitives = new Set([
    "executeSqliteQuerySync",
    "executeSqliteQueryTakeFirstSync",
    "runOpenClawStateWriteTransaction",
    "runOpenClawAgentWriteTransaction",
    "withOpenClawAgentDatabaseReadOnly",
  ]);
  const examined = new Set<Symbol>();
  const expandedMembers = new Set<ts.Node>();
  let pending = [...registered.values()];
  while (pending.length > 0) {
    const references: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node) || declarations.get(node)?.reviewed) {
        return;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        references.push(node.expression);
      }
      node.forEachChild(visit);
    };
    const members: BoundaryOperation[] = [];
    for (const operation of pending) {
      const node = operation.node;
      const returned = (value: ts.Expression) => {
        if (
          ts.isParenthesizedExpression(value) ||
          ts.isAsExpression(value) ||
          ts.isSatisfiesExpression(value)
        ) {
          returned(value.expression);
        } else if (ts.isObjectLiteralExpression(value)) {
          for (const property of value.properties) {
            if (
              ts.isMethodDeclaration(property) ||
              ts.isGetAccessorDeclaration(property) ||
              ts.isSetAccessorDeclaration(property)
            ) {
              members.push(addMember(operation, property));
            } else if (
              ts.isPropertyAssignment(property) &&
              (ts.isArrowFunction(property.initializer) ||
                ts.isFunctionExpression(property.initializer))
            ) {
              members.push(addMember(operation, property.initializer));
            }
          }
        } else if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
          members.push(addMember(operation, value));
        }
      };
      const findReturns = (child: ts.Node) => {
        if (ts.isFunctionLikeDeclaration(child)) {
          return;
        }
        if (ts.isReturnStatement(child) && child.expression) {
          returned(child.expression);
        }
        child.forEachChild(findReturns);
      };
      if (ts.isClassDeclaration(node)) {
        // Class-definition effects run without constructing a receiver. Inherited
        // or field-bearing instances also need a separate ownership proof.
        if (
          node.heritageClauses?.length ||
          node.modifiers?.some((modifier) => ts.isDecorator(modifier)) ||
          node.members.some(
            (member) =>
              ts.isPropertyDeclaration(member) ||
              ts.isClassStaticBlockDeclaration(member) ||
              ((ts.isConstructorDeclaration(member) ||
                ts.isMethodDeclaration(member) ||
                ts.isGetAccessorDeclaration(member) ||
                ts.isSetAccessorDeclaration(member)) &&
                ((!ts.isConstructorDeclaration(member) && ts.isComputedPropertyName(member.name)) ||
                  member.modifiers?.some((modifier) => ts.isDecorator(modifier)) ||
                  member.parameters.some((parameter) =>
                    parameter.modifiers?.some((modifier) => ts.isDecorator(modifier)),
                  ))),
          )
        ) {
          operation.valid = false;
        } else {
          for (const member of node.members) {
            if (
              ts.isConstructorDeclaration(member) ||
              ts.isMethodDeclaration(member) ||
              ts.isGetAccessorDeclaration(member) ||
              ts.isSetAccessorDeclaration(member)
            ) {
              members.push(addMember(operation, member));
            }
          }
        }
      } else if (node.body) {
        if (ts.isBlock(node.body)) {
          node.body.forEachChild(findReturns);
        } else {
          returned(node.body);
        }
        visit(node.body);
      }
    }
    pending = members.filter((member) => !expandedMembers.has(member.node));
    for (const member of pending) {
      expandedMembers.add(member.node);
    }
    const symbols = references.length ? checker.getSymbolAtLocation(references) : [];
    for (const raw of symbols) {
      const symbol = resolveSymbol(raw);
      if (!symbol || examined.has(symbol) || registered.has(symbol)) {
        continue;
      }
      examined.add(symbol);
      if (primitives.has(symbol.name)) {
        continue;
      }
      const declaration = symbol.valueDeclaration?.resolve();
      const node =
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
          ? declaration.initializer
          : declaration;
      if (
        !node ||
        !(
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)
        ) ||
        (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !node.name) ||
        (ts.isFunctionDeclaration(node) && !node.body)
      ) {
        continue;
      }
      const file = path.relative(root, node.getSourceFile().fileName).split(path.sep).join("/");
      if (!sourceTexts.has(file)) {
        continue;
      }
      const name = operationName(node);
      if (isNonRuntime(file, name)) {
        continue;
      }
      const operation: BoundaryOperation = {
        file,
        name,
        valid: true,
        reviewed: false,
        candidate: false,
        nonRuntimeValid: true,
        entries: new Set(),
        node,
      };
      registered.set(symbol, operation);
      declarations.set(node, operation);
      const nameNode =
        declaration && ts.isVariableDeclaration(declaration)
          ? declaration.name
          : "name" in node
            ? node.name
            : undefined;
      if (nameNode && ts.isIdentifier(nameNode)) {
        declarationNames.add(nameNode);
        names.add(nameNode.text);
      }
      pending.push(operation);
    }
  }
  const aliases: [string, string][] = [];
  const namespaces: (ts.Identifier | ts.StringLiteral)[] = [];
  const bindings: ts.VariableDeclaration[] = [];
  for (const { source } of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        aliases.push([node.propertyName?.text ?? node.name.text, node.name.text]);
      } else if (ts.isImportClause(node) && node.name) {
        aliases.push(["default", node.name.text]);
      } else if (ts.isNamespaceImport(node) || ts.isNamespaceExport(node)) {
        namespaces.push(node.name);
      } else if (ts.isVariableDeclaration(node) && node.initializer) {
        bindings.push(node);
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }
  const contained = new Map<Symbol, Set<BoundaryOperation>>();
  const targets = (rawSymbol: Symbol | undefined): Set<BoundaryOperation> => {
    const symbol = resolveSymbol(rawSymbol);
    if (!symbol) {
      return new Set();
    }
    const cached = contained.get(symbol);
    if (cached) {
      return cached;
    }
    const found = new Set<BoundaryOperation>();
    contained.set(symbol, found);
    // Instantiated receiver properties retain their declaration, but get a new symbol.
    const declaration = symbol.valueDeclaration?.resolve();
    const direct =
      registered.get(symbol) ??
      symbol.declarations
        .map((contract) => {
          const resolved = contract.resolve();
          return resolved ? contractDeclarations.get(resolved) : undefined;
        })
        .find((operation) => operation !== undefined) ??
      (declaration
        ? declarations.get(
            ts.isPropertyAssignment(declaration) ? declaration.initializer : declaration,
          )
        : undefined);
    if (direct) {
      found.add(direct);
    } else if (symbol.flags & SymbolFlags.Module) {
      for (const member of checker.getExportsOfModule(symbol)) {
        for (const operation of targets(member)) {
          found.add(operation);
        }
      }
    }
    return found;
  };
  const namespaceSymbols = checker.getSymbolAtLocation(namespaces);
  for (const [index, namespace] of namespaces.entries()) {
    if (targets(namespaceSymbols[index]).size) {
      names.add(namespace.text);
    }
  }
  // Candidate spelling narrows native queries; declaration identity decides every exemption.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, to] of aliases) {
      if (names.has(from) && !names.has(to)) {
        names.add(to);
        changed = true;
      }
    }
  }
  const handledImports = new Set<ts.Node>();
  const handledImportBindings = new Set<ts.Node>();
  for (const binding of bindings) {
    const initializer = binding.initializer!;
    const expression = ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
    const dynamicImport =
      ts.isCallExpression(expression) && expression.expression.kind === ts.SyntaxKind.ImportKeyword
        ? expression
        : undefined;
    const module = dynamicImport?.arguments[0]
      ? resolveSymbol(checker.getSymbolAtLocation(dynamicImport.arguments[0]))
      : undefined;
    if (!dynamicImport || !module) {
      continue;
    }
    const record = (name: ts.Identifier, target: Symbol | undefined) => {
      const local = checker.getSymbolAtLocation(name);
      if (local && target) {
        forwarded.set(local, target);
        handledImportBindings.add(name);
        if (targets(target).size) {
          names.add(name.text);
        }
      }
    };
    if (ts.isObjectBindingPattern(binding.name)) {
      if (
        binding.name.elements.some(
          (element) =>
            !ts.isBindingElement(element) ||
            !element.name ||
            !ts.isIdentifier(element.name) ||
            element.dotDotDotToken ||
            (element.propertyName && ts.isComputedPropertyName(element.propertyName)),
        )
      ) {
        continue;
      }
      for (const element of binding.name.elements) {
        if (!ts.isBindingElement(element) || !element.name || !ts.isIdentifier(element.name)) {
          continue;
        }
        const key =
          element.propertyName?.getText().replace(/^['"]|['"]$/g, "") ?? element.name.text;
        record(element.name, checker.getMemberInModuleExports(module, key));
      }
      handledImports.add(dynamicImport);
    } else if (ts.isIdentifier(binding.name)) {
      record(binding.name, module);
      handledImports.add(dynamicImport);
    }
  }
  const edges = new Map<BoundaryOperation, Set<BoundaryOperation>>();
  const callerEdges = new Map<BoundaryOperation, Set<BoundaryOperation>>();
  const runtimeReferences = new Set<BoundaryOperation>();
  for (const [owner, members] of families) {
    const outgoing = edges.get(owner) ?? new Set<BoundaryOperation>();
    for (const member of members) {
      outgoing.add(member);
    }
    edges.set(owner, outgoing);
    for (const member of members) {
      const memberEdges = edges.get(member) ?? new Set<BoundaryOperation>();
      memberEdges.add(owner);
      edges.set(member, memberEdges);
    }
  }
  const compiledAccesses = new Map<ts.Expression, Symbol | undefined>();
  const compilerSymbol = (expression: ts.Expression): Symbol | undefined =>
    compiledAccesses.has(expression)
      ? compiledAccesses.get(expression)
      : checker.getSymbolAtLocation(expression);
  const accessSymbol = (expression: ts.Expression): Symbol | undefined => {
    const known = resolveSymbol(compilerSymbol(expression));
    if (known) {
      return known;
    }
    if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) {
      return accessSymbol(expression.expression);
    }
    if (
      ts.isCallExpression(expression) &&
      expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
      expression.arguments[0]
    ) {
      return resolveSymbol(compilerSymbol(expression.arguments[0]));
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const base = accessSymbol(expression.expression);
      if (base && base.flags & SymbolFlags.Module) {
        return checker.getMemberInModuleExports(base, expression.name.text);
      }
    }
    return undefined;
  };
  const selectsImportMember = (call: ts.CallExpression): boolean => {
    let expression: ts.Expression = call;
    while (
      (ts.isAwaitExpression(expression.parent) ||
        ts.isParenthesizedExpression(expression.parent)) &&
      expression.parent.expression === expression
    ) {
      expression = expression.parent;
    }
    return (
      (ts.isPropertyAccessExpression(expression.parent) &&
        expression.parent.expression === expression) ||
      (ts.isElementAccessExpression(expression.parent) &&
        expression.parent.expression === expression &&
        ts.isStringLiteral(expression.parent.argumentExpression))
    );
  };
  for (const { file, source } of sources) {
    const references: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      // `extends` is a runtime reference even though its AST wrapper is a type.
      if (
        ts.isExpressionWithTypeArguments(node) &&
        ts.isHeritageClause(node.parent) &&
        node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(node.parent.parent) || ts.isClassExpression(node.parent.parent))
      ) {
        visit(node.expression);
        return;
      }
      if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        return;
      }
      if (
        (((ts.isIdentifier(node) || ts.isStringLiteral(node)) && names.has(node.text)) ||
          (ts.isStringLiteral(node) &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
            !handledImports.has(node.parent) &&
            !selectsImportMember(node.parent))) &&
        !declarationNames.has(node) &&
        !handledImportBindings.has(node) &&
        !declarations.has(node.parent) &&
        !(
          ts.isBindingElement(node.parent) &&
          node.parent.name === node &&
          (node.parent.propertyName || !ts.isObjectBindingPattern(node.parent.parent))
        ) &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      ) {
        references.push(node);
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
    const symbols = references.length ? checker.getSymbolAtLocation(references) : [];
    compiledAccesses.clear();
    const pendingAccesses = new Set<ts.Expression>();
    for (const [index, node] of references.entries()) {
      if (symbols[index]) {
        continue;
      }
      const parent = node.parent;
      let receiver: ts.Expression | undefined =
        ts.isPropertyAccessExpression(parent) && parent.name === node
          ? parent
          : ts.isElementAccessExpression(parent) && ts.isStringLiteral(node)
            ? parent.expression
            : undefined;
      while (receiver && !pendingAccesses.has(receiver)) {
        pendingAccesses.add(receiver);
        receiver =
          ts.isAwaitExpression(receiver) ||
          ts.isParenthesizedExpression(receiver) ||
          ts.isPropertyAccessExpression(receiver)
            ? receiver.expression
            : ts.isCallExpression(receiver) &&
                receiver.expression.kind === ts.SyntaxKind.ImportKeyword
              ? receiver.arguments[0]
              : undefined;
      }
    }
    // Query the same receiver nodes as the fallback, without a round trip per access.
    const accessLocations = [...pendingAccesses];
    const accessSymbols = accessLocations.length
      ? checker.getSymbolAtLocation(accessLocations)
      : [];
    for (const [index, expression] of accessLocations.entries()) {
      compiledAccesses.set(expression, accessSymbols[index]);
    }
    for (const [index, node] of references.entries()) {
      const bindingMember =
        ts.isIdentifier(node) &&
        ts.isBindingElement(node.parent) &&
        node.parent.name === node &&
        !node.parent.propertyName &&
        ts.isObjectBindingPattern(node.parent.parent)
          ? checker.getTypeAtLocation(node.parent.parent).getProperty(node.text)
          : undefined;
      let symbol = resolveSymbol(
        bindingMember ??
          (ts.isShorthandPropertyAssignment(node.parent)
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : symbols[index]),
      );
      if (!symbol && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
        symbol = resolveSymbol(accessSymbol(node.parent));
      }
      if (!symbol && ts.isElementAccessExpression(node.parent) && ts.isStringLiteral(node)) {
        const base = accessSymbol(node.parent.expression);
        if (base && base.flags & SymbolFlags.Module) {
          symbol = resolveSymbol(checker.getMemberInModuleExports(base, node.text));
        }
      }
      const callees = targets(symbol);
      if (!callees.size) {
        continue;
      }
      // Namespace member access is inspected at its member. A computed/escaped
      // namespace cannot prove which member will be used, so it remains a caller.
      if (
        symbol &&
        symbol.flags & SymbolFlags.Module &&
        ((ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) ||
          (ts.isElementAccessExpression(node.parent) &&
            node.parent.expression === node &&
            ts.isStringLiteral(node.parent.argumentExpression)))
      ) {
        continue;
      }
      let owner: BoundaryOperation | undefined;
      let unprovenCallback = false;
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        owner = declarations.get(parent);
        if (owner) {
          break;
        }
        if (
          ts.isMethodDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
            !isInlineInvocation(parent) &&
            // Reviewed worker-only modules retain their callbacks in the worker realm.
            classifyEntry(file, "") !== "W")
        ) {
          unprovenCallback = ts.isArrowFunction(parent) || ts.isFunctionExpression(parent);
          break;
        }
      }
      for (const callee of callees) {
        const expression =
          ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)
            ? node.parent
            : node;
        const directCall =
          (ts.isCallExpression(expression.parent) || ts.isNewExpression(expression.parent)) &&
          expression.parent.expression === expression;
        if (owner && directCall) {
          const outgoing = edges.get(owner) ?? new Set<BoundaryOperation>();
          outgoing.add(callee);
          edges.set(owner, outgoing);
          const calls = callerEdges.get(owner) ?? new Set<BoundaryOperation>();
          calls.add(callee);
          callerEdges.set(owner, calls);
        } else {
          let nonRuntime = false;
          if (!unprovenCallback) {
            const enclosingNames: string[] = [];
            for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
              if (
                (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) &&
                parent.name &&
                ts.isIdentifier(parent.name)
              ) {
                enclosingNames.unshift(parent.name.text);
              }
            }
            const name = enclosingNames.join(".");
            const tier = classifyEntry(file, name);
            const consumer = expression.parent;
            const receiver =
              ts.isCallExpression(consumer) &&
              resolveSymbol(
                checker.getSymbolAtLocation(consumer.expression),
              )?.valueDeclaration?.resolve();
            const reviewedForward =
              tier === "T3" &&
              ts.isCallExpression(consumer) &&
              receiver &&
              ts.isFunctionDeclaration(receiver) &&
              path.relative(root, receiver.getSourceFile().fileName).split(path.sep).join("/") ===
                file &&
              nonRuntimeMemberForwards
                .get(file)
                ?.some(
                  (forward) =>
                    forward.caller === name &&
                    callee.file === file &&
                    forward.member === callee.name &&
                    forward.receiver === operationName(receiver) &&
                    consumer.arguments[forward.argument] === expression,
                );
            nonRuntime = Boolean(
              (directCall || reviewedForward) &&
              (tier !== undefined ||
                ((!callee.reviewed || callee.candidate) && isNonRuntime(file, name))),
            );
            if (nonRuntime && tier) {
              callee.entries.add(tier);
            } else {
              callee.nonRuntimeValid = false;
            }
          } else {
            callee.nonRuntimeValid = false;
          }
          if (nonRuntime) {
            continue;
          }
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart());
          if (callee.reviewed && !callee.candidate) {
            violations.push(
              `${file}:${line + 1}:${character + 1}: bundled runtime reference to deprecated synchronous SQLite API ${callee.file}:${callee.name}`,
            );
          }
          callee.valid = false;
          runtimeReferences.add(callee);
        }
      }
    }
  }
  const compatibilityReachable = new Set(
    [...registered.values()].filter((operation) => operation.reviewed && !operation.candidate),
  );
  for (const operation of compatibilityReachable) {
    for (const callee of edges.get(operation) ?? []) {
      compatibilityReachable.add(callee);
    }
  }
  // A public export can be called outside this source snapshot. Only reviewed
  // deprecated boundaries may rely on the separate compatibility contract.
  for (const { file, source } of sources) {
    if (
      !file.startsWith("src/plugin-sdk/") &&
      !/^extensions\/[^/]+\/(?:runtime-api|api)\.ts$/.test(file)
    ) {
      continue;
    }
    for (const operation of targets(checker.getSymbolAtLocation(source))) {
      if (!compatibilityReachable.has(operation)) {
        operation.nonRuntimeValid = false;
      }
    }
  }
  // A reachable wrapper also makes its callees live.
  changed = true;
  while (changed) {
    changed = false;
    for (const [caller, callees] of edges) {
      for (const callee of callees) {
        if (!caller.valid && callee.valid) {
          callee.valid = false;
          changed = true;
        }
        if (!caller.nonRuntimeValid && callee.nonRuntimeValid) {
          callee.nonRuntimeValid = false;
          changed = true;
        }
        for (const tier of caller.entries) {
          if (!callee.entries.has(tier)) {
            callee.entries.add(tier);
            changed = true;
          }
        }
      }
    }
  }
  // An unproven member keeps its family live, but does not establish a factory caller.
  for (const caller of runtimeReferences) {
    for (const callee of [...(callerEdges.get(caller) ?? []), ...(families.get(caller) ?? [])]) {
      runtimeReferences.add(callee);
    }
  }
  for (const operation of declarations.values()) {
    if (
      operation.reviewed &&
      !operation.candidate &&
      runtimeReferences.has(operation) &&
      !violations.some((violation) => violation.includes(`${operation.file}:${operation.name}`))
    ) {
      violations.push(
        `${operation.file}:${operation.name}: reviewed compatibility operation is reachable through a live or escaped kernel`,
      );
    }
    const compatibility = compatibilityReachable.has(operation);
    if (
      operation.valid &&
      (compatibility || (operation.nonRuntimeValid && operation.entries.size))
    ) {
      const selectedLocations = compatibility ? callLocations : nonRuntimeCallLocations;
      if (compatibility) {
        const selected = operations.get(operation.file) ?? new Set<string>();
        selected.add(operation.name);
        operations.set(operation.file, selected);
      } else {
        const selected =
          nonRuntimeOperations.get(operation.file) ?? new Map<string, NonRuntimeTier>();
        const tier = operation.entries.has("T2") ? "T2" : operation.entries.has("T3") ? "T3" : "W";
        selected.set(operation.name, tier);
        nonRuntimeOperations.set(operation.file, selected);
      }
      const locations = selectedLocations.get(operation.file) ?? new Set<string>();
      const source = operation.node.getSourceFile();
      const visit = (node: ts.Node) => {
        if (ts.isFunctionLikeDeclaration(node) && node !== operation.node) {
          // Only IIFEs and reviewed callback entries retain this execution scope.
          if (!isInlineInvocation(node)) {
            return;
          }
        }
        if (ts.isCallExpression(node)) {
          const { line, character } = source.getLineAndCharacterOfPosition(
            node.expression.getStart(),
          );
          locations.add(`${line + 1}:${character + 1}`);
        }
        node.forEachChild(visit);
      };
      visit(operation.node);
      selectedLocations.set(operation.file, locations);
    }
  }
  return {
    operations,
    callLocations,
    nonRuntimeOperations,
    nonRuntimeCallLocations,
    violations: [...new Set(violations)].toSorted(),
  };
}
