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
const sessionMembers = "src/config/sessions/session-sharing-store.native.ts";
const sessionArtifacts = "src/config/sessions/session-accessor.sqlite-node-artifacts.ts";
const sessionEntries = "src/config/sessions/session-accessor.sqlite-entry-store.ts";
const authCells = "src/agents/auth-profiles/sqlite-json-write.ts";
const authRelocation = "src/infra/state-migrations.shared-auth-store.ts";
const machineState = "src/state/config-machine-state-write.ts";
const credentialAuthority = "src/state/user-model-account-authority.ts";
const credentialCustody = "src/agents/auth-profiles/credential-write-custody.ts";
const authSqlite = "src/agents/auth-profiles/sqlite.ts";
const authStore = "src/agents/auth-profiles/store.ts";
const authRuntime = "src/agents/auth-profiles/store-runtime.ts";
const authUpdate = "src/agents/auth-profiles/store-update.ts";
const authEnrollment = "src/agents/auth-profiles/authorization-enrollment.ts";
const authEnrollmentRuntime = "src/agents/auth-profiles/authorization-enrollment-runtime.ts";
const authKernel = "src/agents/auth-profiles/store-update.worker.ts";
const authProfiles = "src/agents/auth-profiles/profiles.ts";
const authStorage = "src/agents/sessions/auth-storage.ts";
const catalogWorker = "src/agents/prepared-model-catalog.worker.ts";
const factory = (name: string) => key(authStore, `createAuthProfileStoreRuntime/${name}`);
const guardedTables = new Set([
  "secret_store_entries",
  "auth_profile_store",
  "config_machine_state",
  "github_publication_requests",
  "github_personal_publication_requests",
  "github_repository_publication_requests",
  "github_publication_session_lifecycles",
  "session_members",
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

const recommendationCallbacks = new Map(
  (
    [
      ["writeOnboardingRecommendationsOffer", "onboardingRecommendations.writeOffer"],
      ["acknowledgeOnboardingRecommendations", "onboardingRecommendations.acknowledge"],
      ["updatePendingOnboardingRecommendations", "onboardingRecommendations.updatePending"],
      ["clearPendingOnboardingRecommendations", "onboardingRecommendations.clearPending"],
    ] as const
  ).map(([name, operationName]) => [
    key("src/state/onboarding-recommendations.kernel.ts", name),
    key("src/state/onboarding-recommendations.kernel.ts", operationName),
  ]),
);

// Native SDK compatibility has exact exported roots; workers must enter a host publication route.
const authCredentialCallers = new Map<string, readonly string[]>([
  [
    key(authStorage, "AuthStorage"),
    ["forAgent", "forAgentAsync", "fromStorage", "inMemory"].map((name) =>
      key(authStorage, `AuthStorage/${name}`),
    ),
  ],
  [key(authStorage, "AuthStorage/forAgent"), [key(authStorage, "AuthStorage/create")]],
  [key(authStorage, "AuthStorage/create"), []],
  [
    key(authUpdate, "runPreparedAuthProfileStoreUpdate"),
    [key(authUpdate, "runAuthProfileStoreUpdate")],
  ],
  [
    key(authUpdate, "runAuthProfileStoreUpdate"),
    [
      key(authUpdate, "createAuthProfileStoreUpdater/updateAuthProfileStoreWithLock"),
      key(authProfiles, "removeAuthProfileTargetsWithLocks"),
      key(authProfiles, "removeAuthProfileTargetsWithLocks/publish"),
      key("src/agents/auth-profiles/upsert-with-lock.ts", "persistAuthProfileBatch"),
      key("src/agents/auth-profiles/candidate-stores.ts", "runCandidateAuthProfileUpdate"),
      key("src/agents/sessions/auth-storage.ts", "SqliteAuthStorageBackend/updateAsync"),
      key(
        "src/system-agent/setup-inference-credential-access.ts",
        "activateSavedSetupCredential/replaceCredential",
      ),
    ],
  ],
  [
    key(credentialCustody, "withAuthProfileCredentialOwner"),
    [
      key(credentialCustody, "withAuthProfileCredentialWriteCustody"),
      key(authSqlite, "runAuthProfileWriteTransaction"),
    ],
  ],
  [
    key(authCells, "writeAuthProfileJsonCell"),
    [
      key(authSqlite, "mutateAuthProfileCell/write"),
      key(authKernel, "updateAuthProfileStoreInDatabase"),
      key(authEnrollment, "enrollAuthProfileAuthorizationInDatabase"),
      key("src/agents/auth-profiles/inline-usage-kernel.ts", "recordInlineAuthFailureInDatabase"),
      key("src/agents/auth-profiles/usage-kernel.ts", "recordAuthProfileUsageInDatabase"),
    ],
  ],
  // Enrollment preserves credential bytes with a CAS in the existing admitted transaction.
  // Guard both worker entry points and their host dispatch; no raw writer escapes this chain.
  [
    key(authEnrollment, "enrollAuthProfileAuthorizationInDatabase"),
    [
      key(authWorker, "authProfiles.enrollAuthorization"),
      key("src/agents/auth-profiles/inline-usage.worker.ts", "bindSqliteWorkerBackend/execute"),
    ],
  ],
  [
    key(authEnrollmentRuntime, "enrollOwnedAuthProfileAuthorization"),
    [key("src/agents/auth-profiles/authorization.ts", "captureAuthProfileAuthorization")],
  ],
  [
    key(authCells, "deleteAuthProfileJsonCell"),
    [
      key(authSqlite, "mutateAuthProfileCell/write"),
      key(authKernel, "updateAuthProfileStoreInDatabase"),
    ],
  ],
  [
    key(authSqlite, "mutateAuthProfileCell"),
    [
      "writePersistedAuthProfileStoreRaw",
      "deletePersistedAuthProfileStoreRaw",
      "writePersistedAuthProfileStateRaw",
    ].map((name) => key(authSqlite, name)),
  ],
  [
    key(authSqlite, "writePersistedAuthProfileStoreRaw"),
    [
      key(authStore, "restoreAuthProfileStorePersistenceSnapshot"),
      factory("saveAuthProfileStoreInTransaction"),
      key(
        "src/commands/doctor-auth-flat-profiles.ts",
        "maybeRepairLegacyAuthProfileStores/migrate",
      ),
    ],
  ],
  [
    key(authSqlite, "deletePersistedAuthProfileStoreRaw"),
    [key(authStore, "restoreAuthProfileStorePersistenceSnapshot")],
  ],
  [
    factory("saveAuthProfileStoreInTransaction"),
    [
      "maybeSyncPersistedExternalCliAuthProfiles",
      "save",
      "saveAuthProfileStore",
      "saveAuthProfileStoreWithPreparedOwner",
      "saveAuthProfileStoreIfPersistenceSnapshotMatches",
    ].map(factory),
  ],
  [factory("maybeSyncPersistedExternalCliAuthProfiles"), [factory("loadAuthProfileStoreForAgent")]],
  [factory("saveAuthProfileStoreWithPreparedOwner"), [factory("saveAuthProfileStore")]],
  [factory("saveAuthProfileStore"), []],
  [factory("saveAuthProfileStoreIfPersistenceSnapshotMatches"), []],
  [
    key(authStore, "createAuthProfileStoreRuntime"),
    [key("src/plugins/loader-runtime-load.ts", "<module>")],
  ],
  [
    key(authStore, "restoreAuthProfileStorePersistenceSnapshot"),
    [key("src/secrets/apply.ts", "runSecretsApply")],
  ],
  [
    key(authRuntime, "saveAuthProfileStore"),
    [
      key(authProfiles, "upsertAuthProfile"),
      key(
        "src/commands/onboard-non-interactive/local/auth-choice.plugin-providers.ts",
        "applyNonInteractivePluginProviderChoice",
      ),
    ],
  ],
  [
    key(authRuntime, "saveAuthProfileStoreWithPreparedOwner"),
    [
      key("src/agents/auth-profiles/candidate-stores.ts", "runCandidateAuthProfileUpdate"),
      key("src/agents/sessions/auth-storage.ts", "SqliteAuthStorageBackend/withLock"),
      key("src/commands/doctor-auth-flat-profiles.ts", "maybeMigrateAuthProfileJsonStoresToSqlite"),
    ],
  ],
  [
    key(authRuntime, "saveAuthProfileStoreIfPersistenceSnapshotMatches"),
    [key("src/secrets/apply.ts", "runSecretsApply")],
  ],
  [
    key(authProfiles, "upsertAuthProfile"),
    [key("src/plugins/provider-auth-helpers.ts", "upsertApiKeyProfile")],
  ],
  [key("src/plugins/provider-auth-helpers.ts", "upsertApiKeyProfile"), []],
  [
    key(authKernel, "updateAuthProfileStoreInDatabase"),
    [
      key(authWorker, "authProfiles.update"),
      key("src/agents/auth-profiles/inline-usage.worker.ts", "bindSqliteWorkerBackend/execute"),
    ],
  ],
  [
    key(authUpdate, "createAuthProfileStoreUpdater"),
    [key(authStore, "createAuthProfileStoreRuntime")],
  ],
  [
    key("src/agents/auth-profiles/runtime-scope.ts", "withWorkerAuthProfileWrites"),
    [key(catalogWorker, "<module>")],
  ],
  [
    key(credentialAuthority, "captureAuthProfileCredentialCommits"),
    [key(catalogWorker, "<module>")],
  ],
  [
    key(credentialAuthority, "beginAuthProfileCredentialBatch"),
    [
      key(
        "src/agents/prepared-model-catalog-worker.ts",
        "createPreparedModelCatalogWorker/request",
      ),
    ],
  ],
]);

const genericCredentialCallers = new Map<string, readonly string[]>([
  [
    key(machineState, "upsertConfigMachineState"),
    [
      "writeConfigMachineState",
      "writeConfigMachineStateInDatabase",
      "updateConfigMachineStateInDatabase",
    ].map((name) => key(machineState, name)),
  ],
  [
    key(machineState, "writeConfigMachineStateInDatabase"),
    [
      key("src/state/config-machine-state.worker.ts", "machineState.write"),
      // localOnboardingStateKey always uses the onboarding.local. namespace.
      key("src/state/local-onboarding-state.worker.ts", "localOnboarding.complete"),
    ],
  ],
  [
    key(machineState, "updateConfigMachineStateInDatabase"),
    [key(machineState, "updateConfigMachineState")],
  ],
  // These keys are built by bounded prefixes in the reviewed owners, never copied from a command.
  [
    key(machineState, "writeConfigMachineState"),
    [
      key("src/state/openclaw-state-worker-runtime.ts", "executeSharedStateCommand"),
      key("src/commands/doctor/shared/legacy-webhook-pins.ts", "recordUnwrittenWebhookCompletion"),
    ],
  ],
  [
    key(machineState, "updateConfigMachineState"),
    [
      key("src/tui/tui-last-session.kernel.ts", "clearRetiredTuiPointers"),
      ...["beginLocalOnboarding", "completeLocalOnboarding"].map((name) =>
        key("src/state/local-onboarding-state.ts", name),
      ),
      key("src/daemon/runtime-pin-state.ts", "commitDaemonRuntimePin"),
      ...[
        "writeOnboardingRecommendationsOffer",
        "acknowledgeOnboardingRecommendations",
        "updatePendingOnboardingRecommendations",
        "clearPendingOnboardingRecommendations",
      ].map((name) => key("src/state/onboarding-recommendations.kernel.ts", name)),
    ],
  ],
  [
    key(machineState, "deleteConfigMachineState"),
    [key("src/state/onboarding-recommendations.kernel.ts", "onboardingRecommendations.clear")],
  ],
  [
    key(machineState, "importConfigMachineState"),
    [key("src/infra/state-migrations.config-machine-state.ts", "migrateLegacyConfigMachineState")],
  ],
]);

// Native readers can synchronize external CLI credentials; their reviewed entries stay explicit.
const nativeReadCallers = new Map<string, readonly string[]>([
  [
    key(authRuntime, "ensureAuthProfileStore"),
    [
      "extensions/codex/src/account-usage-runtime.ts:handleCodexAccountUsage/assertCurrent",
      "extensions/codex/src/app-server/auth-profile.ts:<module>",
      "extensions/codex/src/app-server/auth-profile-selection.ts:createCodexAuthProfileSelection/resolveCodexAppServerAuthProfileIdAtEffect",
      "extensions/codex/src/command-diagnostics.ts:resolvePendingCodexDiagnosticsTargets",
      "src/agents/embedded-agent-runner/cli-backend-dispatch-eligibility.ts:resolveEmbeddedCliBackendDispatchEligibility",
      "src/agents/model-auth-label.ts:resolveModelAuthLabel",
      "src/agents/model-auth-provider.ts:resolveScopedAuthProfileStore",
      "src/commands/auth-choice.model-check.ts:resolveDefaultModelAuthStatus",
      "src/commands/doctor-auth.ts:hasStoredCodexOAuthProfile",
      "src/commands/models/auth-list.ts:modelsAuthListCommand",
      "src/commands/models/auth-order.ts:modelsAuthOrderGetCommand",
      "src/commands/models/auth-order.ts:modelsAuthOrderUpdateCommand",
      "src/commands/models/list.probe.ts:buildProbeTargets",
      "src/commands/models/list.status-command.ts:modelsStatusCommand",
      "src/commands/onboard-non-interactive/api-keys.ts:resolveApiKeyFromProfiles",
      "src/infra/provider-usage.auth.ts:resolveLegacyProviderApiKeyCandidatesFromConfigAndStore",
      "src/plugin-sdk/provider-auth-runtime.ts:resolveProviderAuthProfileMetadata",
      "src/plugins/provider-auth-availability-core.ts:createProviderAuthAvailability/isProviderApiKeyConfiguredFromStore",
    ],
  ],
  [factory("ensureAuthProfileStore"), []],
  [
    key(
      "src/agents/auth-profiles/store-read.ts",
      "createAuthProfileStoreReadRuntime/ensureAuthProfileStore",
    ),
    [],
  ],
  [
    key(authRuntime, "ensureAuthProfileStoreWithoutExternalProfiles"),
    [
      "src/agents/openclaw-tools.ts:createOpenClawTools",
      "src/agents/tools/model-config.helpers.ts:loadLegacyToolAuthProfileStore",
      "src/commands/doctor-auth-legacy-oauth.ts:maybeRepairLegacyOAuthProfileIds",
      "src/commands/models/auth-api-key.ts:saveModelProviderApiKey",
      "src/commands/models/auth-logout.ts:modelsAuthLogoutCommand",
      "src/commands/models/list.status-command.ts:modelsStatusCommand",
      "src/gateway/model-account-connect.ts:resolveSharedAuthProfileProvider",
    ],
  ],
  [factory("ensureAuthProfileStoreWithoutExternalProfiles"), []],
  [
    key(
      "src/agents/auth-profiles/store-read.ts",
      "createAuthProfileStoreReadRuntime/ensureAuthProfileStoreWithoutExternalProfiles",
    ),
    [],
  ],
  [
    key(authRuntime, "ensureAuthProfileStoreForLocalUpdate"),
    ["src/agents/auth-profiles/profiles.ts:upsertAuthProfile"],
  ],
  [factory("ensureAuthProfileStoreForLocalUpdate"), []],
  [
    key(authRuntime, "loadAuthProfileStoreForRuntime"),
    [
      "src/agents/cli-execution-auth.ts:resolveCliExecutionAuthProfileId",
      "src/system-agent/setup-inference-profile.ts:resolveSetupInferenceProfileError",
      "src/system-agent/verified-inference.ts:loadRouteAuthProfileStore",
      "src/cli/capability-cli/model.ts:runModelAuthLogout",
      "src/cli/capability-cli/shared.ts:providerHasGenericConfig",
      "src/commands/doctor-auth.ts:loadAuthProfileHealth",
      "src/commands/doctor-auth.ts:noteCopilotAmbientToken",
    ],
  ],
  [
    factory("loadAuthProfileStoreForRuntime"),
    [
      factory("loadRuntimeAuthProfileStore"),
      factory("captureAuthProfileStoreReadScope/read"),
      factory("loadAuthProfileStoreForSecretsRuntime"),
    ],
  ],
  [
    key(
      "src/agents/auth-profiles/runtime-read.ts",
      "createAuthProfileStoreRuntimeReader/loadAuthProfileStoreForRuntime",
    ),
    [],
  ],
]);

// These deferred module projections are already audited; their selected writer calls stay guarded.
const reviewedLazyImports = new Map<string, readonly [string, string, string?]>([
  [
    "src/agents/model-fallback-runner.ts:modelFallbackAuthRuntimeLoader",
    ["createLazyImportLoader", "./auth-profiles.runtime.js"],
  ],
  [
    "src/media-understanding/runner.entries.ts:loadModelAuth",
    ["createLazyRuntimeModule", "../agents/model-auth.js"],
  ],
  [
    "src/media-understanding/runner.ts:loadHasAvailableAuthForProvider",
    ["createLazyRuntimeNamedExport", "../agents/model-auth.js", "hasAvailableAuthForProvider"],
  ],
]);

const nativeSdkExports = new Map<string, readonly string[]>([
  [key(authStorage, "AuthStorage"), ["src/plugin-sdk/agent-sessions.ts"]],
  [
    key(authRuntime, "ensureAuthProfileStore"),
    [
      "src/agents/auth-profiles.runtime.ts",
      "src/agents/auth-profiles.ts",
      "src/agents/model-auth.ts",
      "src/plugin-sdk/agent-runtime.ts",
      "src/plugin-sdk/provider-auth.ts",
      "packages/plugin-sdk/src/provider-auth.ts",
    ],
  ],
  [
    key(authRuntime, "ensureAuthProfileStoreWithoutExternalProfiles"),
    ["src/agents/auth-profiles.ts", "src/agents/model-auth.ts"],
  ],
  [
    key(authRuntime, "ensureAuthProfileStoreForLocalUpdate"),
    ["src/plugin-sdk/provider-auth.ts", "packages/plugin-sdk/src/provider-auth.ts"],
  ],
  [
    key(authRuntime, "loadAuthProfileStoreForRuntime"),
    ["src/agents/auth-profiles.ts", "src/plugin-sdk/agent-runtime.ts"],
  ],

  [
    key(authRuntime, "saveAuthProfileStore"),
    ["src/agents/auth-profiles.ts", "src/plugin-sdk/agent-runtime.ts"],
  ],
  [
    key(authProfiles, "upsertAuthProfile"),
    [
      "src/agents/auth-profiles.ts",
      "src/plugin-sdk/provider-auth.ts",
      "packages/plugin-sdk/src/provider-auth.ts",
    ],
  ],
  [
    key("src/plugins/provider-auth-helpers.ts", "upsertApiKeyProfile"),
    [
      "src/plugin-sdk/provider-auth.ts",
      "src/plugin-sdk/provider-auth-api-key.ts",
      "packages/plugin-sdk/src/provider-auth.ts",
    ],
  ],
]);

// Exact edges, not worker-file exemptions: every new entry needs an owner audit.
const callers = new Map<string, readonly string[]>([
  ...publicationWriters,
  ...["addSessionMember", "removeSessionMember"].map((name): [string, string[]] => [
    key(sessionMembers, name),
    [key("src/config/sessions/session-sharing-store.worker.ts", "bindSqliteWorkerBackend/execute")],
  ]),
  [
    key(sessionArtifacts, "clearSessionCollaborationForKey"),
    [key(sessionEntries, "writeSessionEntry")],
  ],
  [
    key(sessionArtifacts, "deleteSessionNodeArtifacts"),
    [key(sessionEntries, "deleteSessionEntryRows")],
  ],
  // Alias moves publish both canonical entry postimages; the other callers hold offline repair ownership.
  [
    key(sessionArtifacts, "copySessionNodeArtifactsForRepair"),
    [
      key(sessionEntries, "deleteLegacySessionEntryRows"),
      key("src/config/sessions/legacy-main-session-migration-operations.ts", "copyClaimCrossStore"),
      key(
        "src/config/sessions/session-accessor.sqlite-canonical-repair.ts",
        "copySqliteSessionOwnedStateForRepair",
      ),
      key("src/commands/doctor-session-canonical-keys.ts", "applyCanonicalDestinationArtifacts"),
    ],
  ],
  [
    key(sessionArtifacts, "deleteSessionMembersForRepair"),
    [
      key(
        "src/config/sessions/session-accessor.sqlite-canonical-repair.ts",
        "copySqliteSessionOwnedStateForRepair",
      ),
      key("src/commands/doctor-session-canonical-keys.ts", "applyCanonicalDestinationArtifacts"),
    ],
  ],
  ...authCredentialCallers,
  ...[...recommendationCallbacks.keys()].map((id): [string, string[]] => [id, []]),
  ...nativeReadCallers,
  ...genericCredentialCallers,
  [
    key(credentialCustody, "withAuthProfileCredentialWriteCustody"),
    [key(credentialAuthority, "withAuthProfileCredentialWrite"), factory("saveAuthProfileStore")],
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
    [
      key(accounts, "updateUserModelAuthProfile"),
      key(accounts, "connectUserModelAccount"),
      key(accounts, "enrollPersonalAuthProfileAuthorizationInDatabase"),
    ],
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
  // Enrollment preserves credential bytes and requires the same admitted personal writer.
  [
    key(accounts, "enrollPersonalAuthProfileAuthorizationInDatabase"),
    [key(profileWorker, "userProfiles.modelAccount.enrollAuthorization")],
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
  ...["addSessionMember", "removeSessionMember"].map((name): [string, number] => [
    key(sessionMembers, name),
    1,
  ]),
  ...[
    "clearSessionCollaborationForKey",
    "copySessionNodeArtifactsForRepair",
    "deleteSessionMembersForRepair",
    "deleteSessionNodeArtifacts",
  ].map((name): [string, number] => [key(sessionArtifacts, name), 1]),
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

function mayIncludeAuthKey(
  value: ts.Node,
  checker: NativeTypeScriptProject["project"]["checker"],
): boolean {
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some((element) => mayIncludeAuthKey(element, checker));
  }
  const type = checker.getTypeAtLocation(value);
  const variants = type.isUnionType() ? type.getTypes() : [type];
  return variants.some((variant) =>
    variant.isStringLiteralType() ? variant.value.trim() === "authProfiles.store" : true,
  );
}

function mayWriteAuthMachineState(
  node: ts.CallExpression,
  checker: NativeTypeScriptProject["project"]["checker"],
): boolean {
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
          changesKey ||= mayIncludeAuthKey(property.initializer, checker);
        } else {
          selected = mayIncludeAuthKey(property.initializer, checker);
        }
      }
    } else if (method === "onConflict") {
      changesKey ||= conflictUpdateMayIncludeAuthKey(call.arguments[0], checker);
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
      selected &&= mayIncludeAuthKey(call.arguments[2], checker);
    }
    query = call;
  }
  return selected || changesKey;
}

function conflictUpdateMayIncludeAuthKey(
  callback: ts.Node | undefined,
  checker: NativeTypeScriptProject["project"]["checker"],
): boolean {
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
    return false;
  }
  const parameter = callback.parameters[0]?.name;
  const body = callback.body;
  if (!parameter || !ts.isIdentifier(parameter) || !body) {
    return false;
  }
  const statement =
    ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined;
  let query = ts.isBlock(body)
    ? statement && ts.isReturnStatement(statement)
      ? statement.expression
      : undefined
    : body;
  let changesKey = false;
  while (query && ts.isCallExpression(query) && ts.isPropertyAccessExpression(query.expression)) {
    if (query.expression.name.text === "doUpdateSet") {
      const values = query.arguments[0];
      if (values && ts.isObjectLiteralExpression(values)) {
        changesKey ||= values.properties.some(
          (entry) =>
            ts.isPropertyAssignment(entry) &&
            (ts.isIdentifier(entry.name) || ts.isStringLiteralLikeNode(entry.name)) &&
            entry.name.text === "state_key" &&
            mayIncludeAuthKey(entry.initializer, checker),
        );
      }
    }
    query = query.expression.expression;
  }
  return Boolean(query && ts.isIdentifier(query) && query.text === parameter.text && changesKey);
}

const credentialCommandOwners = new Map([
  [
    "machineState.write",
    key("src/state/config-machine-state-async.ts", "writeConfigMachineStateAsync"),
  ],
  ["authProfiles.update", key(authUpdate, "runPreparedAuthProfileStoreUpdate")],
  [
    "authProfiles.enrollAuthorization",
    key(authEnrollmentRuntime, "enrollOwnedAuthProfileAuthorization"),
  ],
]);

const repeatedEdges = new Map([
  ...[
    key(
      "src/config/sessions/session-accessor.sqlite-canonical-repair.ts",
      "copySqliteSessionOwnedStateForRepair",
    ),
    key("src/commands/doctor-session-canonical-keys.ts", "applyCanonicalDestinationArtifacts"),
  ].map((caller): [string, number] => [
    `${key(sessionArtifacts, "copySessionNodeArtifactsForRepair")}<-${caller}`,
    2,
  ]),
  [
    `${key(authUpdate, "runAuthProfileStoreUpdate")}<-${key("src/agents/auth-profiles/upsert-with-lock.ts", "persistAuthProfileBatch")}`,
    2,
  ],
  ...["writeAuthProfileJsonCell", "deleteAuthProfileJsonCell"].map((name): [string, number] => [
    `${key(authCells, name)}<-${key(authKernel, "updateAuthProfileStoreInDatabase")}`,
    2,
  ]),
  [
    `${key(authCells, "writeAuthProfileJsonCell")}<-${key("src/agents/auth-profiles/inline-usage-kernel.ts", "recordInlineAuthFailureInDatabase")}`,
    2,
  ],
  [
    `${key(machineState, "writeConfigMachineStateInDatabase")}<-${key("src/state/config-machine-state.worker.ts", "machineState.write")}`,
    2,
  ],
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
    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        (ts.isFunctionExpression(parent) && !ts.isVariableDeclaration(parent.parent))) &&
      parent.name
    ) {
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
    [...approvedCallers.keys()].map((entry) =>
      entry.slice(Math.max(entry.lastIndexOf(":"), entry.lastIndexOf("/")) + 1),
    ),
  );
  const aliases: [string, string][] = [];
  for (const { file, source } of sources) {
    const visit = (node: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isClassDeclaration(node) ||
          (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent)) ||
          ts.isVariableDeclaration(node) ||
          ts.isBindingElement(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        const enclosing = operation(node);
        const id = key(
          file,
          [enclosing === "<module>" ? "" : enclosing, node.name.text].filter(Boolean).join("/"),
        );
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
  const importedBindings = new Map<Symbol, Symbol>();
  const resolveSymbol = (raw: Symbol | undefined): Symbol | undefined => {
    const symbol = raw && raw.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
    return symbol && (importedBindings.get(symbol) ?? symbol);
  };
  const resolved = new Map<Symbol, string[]>();
  const targets = (raw: Symbol | undefined): string[] => {
    if (!raw) {
      return [];
    }
    const symbol = resolveSymbol(raw)!;
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
    } else if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
      found.push(...targets(checker.getShorthandAssignmentValueSymbol(declaration)));
    } else if (symbol.flags & SymbolFlags.Module) {
      for (const member of checker.getExportsOfModule(symbol)) {
        found.push(...targets(member));
      }
    }
    return found;
  };
  const handledImports = new Set<ts.CallExpression>();
  const accessSymbol = (expression: ts.Expression): Symbol | undefined => {
    if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) {
      return accessSymbol(expression.expression);
    }
    if (
      ts.isCallExpression(expression) &&
      expression.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = expression.arguments[0];
      return specifier && resolveSymbol(checker.getSymbolAtLocation(specifier));
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const base = accessSymbol(expression.expression);
      const member = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ts.isStringLiteral(expression.argumentExpression)
          ? expression.argumentExpression.text
          : undefined;
      if (base && member !== undefined) {
        return resolveSymbol(
          base.flags & SymbolFlags.Module
            ? checker.getMemberInModuleExports(base, member)
            : checker.getTypeOfSymbolAtLocation(base, expression.expression).getProperty(member),
        );
      }
    }
    return resolveSymbol(checker.getSymbolAtLocation(expression));
  };
  const bindModule = (binding: ts.BindingName, module: Symbol): boolean => {
    if (ts.isIdentifier(binding)) {
      const local = checker.getSymbolAtLocation(binding);
      if (local) {
        importedBindings.set(local, module);
        names.add(binding.text);
      }
      return true;
    }
    if (
      !ts.isObjectBindingPattern(binding) ||
      binding.elements.some(
        (element) =>
          element.dotDotDotToken ||
          (element.propertyName && ts.isComputedPropertyName(element.propertyName)),
      )
    ) {
      return false;
    }
    for (const element of binding.elements) {
      const bindingName = element.name;
      if (!bindingName) {
        return false;
      }
      const name =
        element.propertyName?.getText().replace(/^["']|["']$/g, "") ?? bindingName.getText();
      const member =
        module.flags & SymbolFlags.Module
          ? checker.getMemberInModuleExports(module, name)
          : checker.getTypeOfSymbolAtLocation(module, binding).getProperty(name);
      if (member && !bindModule(bindingName, member)) {
        return false;
      }
    }
    return true;
  };
  const bindImports = (expression: ts.Expression, binding: ts.BindingName): void => {
    if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) {
      bindImports(expression.expression, binding);
    } else if (ts.isCallExpression(expression)) {
      if (expression.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const module = accessSymbol(expression);
        if (module && bindModule(binding, module)) {
          let parent: ts.Node | undefined = binding.parent;
          while (parent && !ts.isVariableStatement(parent) && !ts.isParameterDeclaration(parent)) {
            parent = parent.parent;
          }
          if (
            !parent ||
            !ts.isVariableStatement(parent) ||
            !parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
          ) {
            handledImports.add(expression);
          }
        }
      } else if (
        ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === "Promise" &&
        expression.expression.name.text === "all" &&
        expression.arguments[0] &&
        ts.isArrayLiteralExpression(expression.arguments[0]) &&
        ts.isArrayBindingPattern(binding)
      ) {
        for (const [index, element] of binding.elements.entries()) {
          const item = expression.arguments[0].elements[index];
          if (item && ts.isBindingElement(element) && element.name && !element.dotDotDotToken) {
            bindImports(item, element.name);
          }
        }
      }
    }
  };
  for (const { source } of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        bindImports(node.initializer, node.name);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "then"
      ) {
        const callback = node.arguments[0];
        if (
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
          callback.parameters[0]
        ) {
          bindImports(node.expression.expression, callback.parameters[0].name);
        }
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }
  const selectsImportMember = (call: ts.CallExpression): boolean => {
    let expression: ts.Expression = call;
    while (
      ts.isAwaitExpression(expression.parent) ||
      ts.isParenthesizedExpression(expression.parent)
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
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteralLikeNode(node.name)) &&
        node.name.text === "type"
      ) {
        const type = checker.getTypeAtLocation(
          ts.isPropertyAssignment(node) ? node.initializer : node.name,
        );
        const variants = type.isUnionType() ? type.getTypes() : [type];
        for (const value of variants) {
          if (!value.isStringLiteralType()) {
            continue;
          }
          const owner = credentialCommandOwners.get(value.value);
          if (owner && key(file, operation(node)) !== owner) {
            fail(node, `${value.value} credential writes require the host publication adapter`);
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["insertInto", "replaceInto", "updateTable", "deleteFrom"].includes(
          node.expression.name.text,
        )
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
          /\b(?:(?:insert\s+(?:or\s+\w+\s+)?|replace\s+)into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["`[]?(session_members|secret_store_entries|auth_profile_store|config_machine_state|github_(?:(?:personal_|repository_)?publication_requests|publication_session_lifecycles))\b/gi,
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
            node.parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
            !handledImports.has(node.parent) &&
            !selectsImportMember(node.parent))) &&
        !(
          (ts.isFunctionDeclaration(node.parent) ||
            ts.isFunctionExpression(node.parent) ||
            ts.isClassDeclaration(node.parent) ||
            ts.isMethodDeclaration(node.parent) ||
            ts.isVariableDeclaration(node.parent) ||
            ts.isBindingElement(node.parent)) &&
          (node.parent.name === node ||
            (ts.isBindingElement(node.parent) && node.parent.propertyName === node))
        )
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
        : (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
            (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
          ? accessSymbol(node.parent)
          : symbols[index];
      if (
        ts.isStringLiteral(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        let expression: ts.Expression = node.parent;
        while (
          ts.isAwaitExpression(expression.parent) ||
          ts.isParenthesizedExpression(expression.parent)
        ) {
          expression = expression.parent;
        }
        const callback = expression.parent;
        const loader = callback.parent;
        if (
          ts.isArrowFunction(callback) &&
          callback.body === expression &&
          ts.isCallExpression(loader) &&
          loader.arguments[0] === callback &&
          ts.isIdentifier(loader.expression) &&
          ts.isVariableDeclaration(loader.parent) &&
          loader.parent.initializer === loader &&
          ts.isIdentifier(loader.parent.name)
        ) {
          const reviewed = reviewedLazyImports.get(key(file, loader.parent.name.text));
          const selected = loader.arguments[1];
          if (
            operation(loader) === "<module>" &&
            reviewed?.[0] === loader.expression.text &&
            reviewed[1] === node.text &&
            (reviewed[2] === undefined ||
              (selected && ts.isStringLiteral(selected) && selected.text === reviewed[2]))
          ) {
            continue;
          }
        }
      }
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
      const call =
        (ts.isCallExpression(expression.parent) || ts.isNewExpression(expression.parent)) &&
        expression.parent.expression === expression
          ? expression.parent
          : undefined;
      const directCall = call !== undefined;
      for (const target of guarded) {
        const caller = key(file, operation(node));
        const exported =
          (ts.isExportSpecifier(node.parent) &&
            nativeSdkExports.get(target)?.includes(file) &&
            node.parent.name.text === target.slice(target.lastIndexOf(":") + 1)) ||
          (nativeSdkExports.get(target)?.includes(file) &&
            file === "packages/plugin-sdk/src/provider-auth.ts" &&
            ts.isExportDeclaration(node.parent) &&
            node.parent.moduleSpecifier === node &&
            !node.parent.exportClause) ||
          (target === key(authStorage, "AuthStorage") &&
            file === "src/agents/sessions/index.ts" &&
            ts.isExportDeclaration(node.parent) &&
            node.parent.moduleSpecifier === node &&
            !node.parent.exportClause);
        // Static members retain their own checks; escaping the class bypasses that selection.
        const selectedAuthStorageMember =
          target === key(authStorage, "AuthStorage") &&
          ((ts.isPropertyAccessExpression(expression.parent) &&
            expression.parent.expression === expression) ||
            (ts.isElementAccessExpression(expression.parent) &&
              expression.parent.expression === expression &&
              ts.isStringLiteral(expression.parent.argumentExpression)));
        const runtimeMember =
          target.startsWith(`${authStore}:createAuthProfileStoreRuntime/`) &&
          (target.includes("/saveAuthProfileStore") || nativeReadCallers.has(target));
        const readerMember =
          target.startsWith(
            "src/agents/auth-profiles/store-read.ts:createAuthProfileStoreReadRuntime/",
          ) ||
          target.startsWith(
            "src/agents/auth-profiles/runtime-read.ts:createAuthProfileStoreRuntimeReader/",
          );
        const returnedMember =
          (runtimeMember || readerMember) &&
          target === `${caller}/${node.getText()}` &&
          ts.isShorthandPropertyAssignment(node.parent) &&
          ts.isObjectLiteralExpression(node.parent.parent) &&
          ts.isReturnStatement(node.parent.parent.parent);
        const forwarded =
          returnedMember ||
          (runtimeMember &&
            ((file === authRuntime &&
              ts.isPropertyAccessExpression(node.parent) &&
              ts.isVariableDeclaration(node.parent.parent) &&
              node.parent.parent.name.getText() === node.getText()) ||
              (file === "src/plugins/loader-runtime-load.ts" &&
                target === factory("ensureAuthProfileStore") &&
                ts.isPropertyAccessExpression(node.parent) &&
                ts.isPropertyAssignment(node.parent.parent) &&
                node.parent.parent.name.getText() === "ensureAuthProfileStore")));
        const boundedRecommendation =
          recommendationCallbacks.get(target) === caller &&
          ts.isCallExpression(expression.parent) &&
          ts.isIdentifier(expression.parent.expression) &&
          expression.parent.expression.text === "recommendationOperation" &&
          expression.parent.arguments[0] === expression;
        if (exported || forwarded || boundedRecommendation || selectedAuthStorageMember) {
          continue;
        }
        if (call && ts.isCallExpression(call) && genericCredentialCallers.has(target)) {
          const name = target.slice(target.lastIndexOf(":") + 1);
          const argument =
            call.arguments[
              name.endsWith("InDatabase") || name === "upsertConfigMachineState" ? 1 : 0
            ];
          if (
            name !== "importConfigMachineState" &&
            argument &&
            !mayIncludeAuthKey(argument, checker)
          ) {
            continue;
          }
        }
        const selectedNativeReader =
          target === key(authRuntime, "loadAuthProfileStoreForRuntime") &&
          ts.isBinaryExpression(node.parent) &&
          node.parent.right === node &&
          node.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
          ts.isPropertyAccessExpression(node.parent.left) &&
          node.parent.left.name.text === "loadAuthProfileStoreForRuntime";
        const selectorDependency =
          target === key(authRuntime, "ensureAuthProfileStore") &&
          file === "extensions/codex/src/app-server/auth-profile.ts" &&
          ts.isShorthandPropertyAssignment(node.parent) &&
          ts.isObjectLiteralExpression(node.parent.parent) &&
          ts.isCallExpression(node.parent.parent.parent) &&
          ts.isIdentifier(node.parent.parent.parent.expression) &&
          node.parent.parent.parent.expression.text === "createCodexAuthProfileSelection";
        const edge = `${target}<-${caller}`;
        const count = (edgeCounts.get(edge) ?? 0) + 1;
        edgeCounts.set(edge, count);
        if (
          (!directCall && !selectedNativeReader && !selectorDependency) ||
          !approvedCallers.get(target)?.includes(caller) ||
          count > (repeatedEdges.get(edge) ?? 1)
        ) {
          const owner = target.includes("src/config/sessions/")
            ? "session membership"
            : target.includes("publication")
              ? "GitHub publication"
              : "personal credential";
          fail(node, `unreviewed ${owner} writer reference to ${target} from ${caller}`);
        }
      }
    }
  }
  return [...new Set(violations)].toSorted();
}
