import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { enrollOwnedAuthProfileAuthorization } from "./auth-profiles/authorization-enrollment-runtime.js";
import { readAuthProfileAuthorizationLifetime } from "./auth-profiles/authorization-lifetime.js";
import { retainAuthProfileAuthorizationObservation } from "./auth-profiles/authorization-observation.js";
import { AUTH_STORE_VERSION, authProfilesLog } from "./auth-profiles/constants.js";
import { assertAuthProfileMigrationCandidates } from "./auth-profiles/legacy-source-diagnostic.js";
import { resolveLegacyAuthProfileSourceCandidates } from "./auth-profiles/legacy-source-files.js";
import {
  resolveSharedAuthStoreOwnershipAsync,
  resolveSharedAuthStorePath,
} from "./auth-profiles/path-resolve.js";
import { readAuthProfileRowsIdentity } from "./auth-profiles/runtime-persisted-rows.js";
import { mergeLocalAuthProfileStoreWithInheritedStore } from "./auth-profiles/runtime-snapshot-owner.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
  readSharedAuthProfileRows,
} from "./auth-profiles/sqlite-read.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import {
  getScopedAuthProfileEnv,
  getScopedSharedAuthStore,
  isEnvOnlyAuthProfileRuntime,
  resolveRuntimeAuthProfileAgentDir,
} from "./auth-profiles/store.js";
import { McpConnectionAuthorityError } from "./mcp-connection-authority-error.js";
import type { McpConnectionAuthority } from "./mcp-connection-authority.types.js";

/** Auth-profile custody is distinct from access-token material and requires no provider call. */
export async function captureMcpAuthProfileAuthorization(params: {
  profileId: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  assertCurrent: () => void;
}): Promise<McpConnectionAuthority> {
  let cleanup: (() => Promise<void>) | undefined;
  const sanitize = (error: unknown): Error =>
    error instanceof McpConnectionAuthorityError
      ? error
      : new McpConnectionAuthorityError("unavailable");
  try {
    const { profileId, assertCurrent: assertCaller, cfg } = params;
    const agentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
    const env = { ...(getScopedAuthProfileEnv() ?? process.env) };
    let disposed = false;
    let retired = false;
    const assertSource = () => {
      if (disposed || retired) {
        throw new McpConnectionAuthorityError("retired");
      }
      try {
        assertCaller();
      } catch {
        retired = true;
        throw new McpConnectionAuthorityError("retired");
      }
    };
    assertSource();
    // These have separate or bounded owners. Never substitute the ambient shared/admin store.
    if (
      isEnvOnlyAuthProfileRuntime() ||
      getScopedSharedAuthStore() ||
      isUserModelAuthProfileId(profileId)
    ) {
      throw new McpConnectionAuthorityError("unavailable");
    }
    const context = captureOpenClawStateWorkerContext({ env });
    const assertRoot = () => {
      assertSource();
      try {
        context.admission.assertCurrent();
        context.maintenanceScope?.assertAdmission();
      } catch {
        retired = true;
        throw new McpConnectionAuthorityError("retired");
      }
    };
    const ownership = await resolveSharedAuthStoreOwnershipAsync(context);
    assertRoot();
    const sharedPath = resolvePathViaExistingAncestorSync(resolveSharedAuthStorePath(env));
    const requestedPath = agentDir
      ? resolvePathViaExistingAncestorSync(resolveAuthProfileDatabasePath(agentDir))
      : sharedPath;
    const paths = [...new Set([requestedPath, sharedPath])];
    type Target = {
      databasePath: string;
      agentId?: string;
      agentDir?: string;
      observation: ReturnType<typeof retainAuthProfileAuthorizationObservation>;
      reader?: ReturnType<typeof prepareAgentAuthProfileRowsRead>;
      incarnation?: string;
    };
    const targets: Target[] = paths.map((databasePath) => ({
      databasePath,
      agentId:
        databasePath === sharedPath && ownership.location === "state-db"
          ? undefined
          : resolveAuthProfileDatabaseOwnerId(path.dirname(databasePath)),
      agentDir: databasePath === sharedPath ? undefined : agentDir,
      observation: retainAuthProfileAuthorizationObservation(databasePath, profileId),
    }));
    const closeReaders = async () => {
      await Promise.all(
        targets.map(async (target) => {
          const reader = target.reader;
          target.reader = undefined;
          await reader?.dispose();
        }),
      );
    };
    const release = () => {
      disposed = true;
      for (const target of targets) {
        target.observation.dispose();
      }
    };
    cleanup = async () => {
      release();
      await closeReaders();
    };
    const assertOwners = () => {
      assertRoot();
      if (resolvePathViaExistingAncestorSync(resolveSharedAuthStorePath(env)) !== sharedPath) {
        retired = true;
        throw new McpConnectionAuthorityError("retired");
      }
      try {
        for (const target of targets) {
          target.reader?.assertCurrent();
        }
      } catch {
        retired = true;
        throw new McpConnectionAuthorityError("retired");
      }
    };
    const readCanonical = async () => {
      assertOwners();
      // The owner cache is process-stable, so also observe another process's relocation explicitly.
      const publishedOwnership = await runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          scope.execute({
            type: "authProfiles.sharedOwnership",
            input: { artifactPreserving: false },
          }),
        { existingOnly: true },
      );
      assertOwners();
      if (
        publishedOwnership === undefined
          ? ownership.location !== "legacy-main"
          : JSON.stringify(publishedOwnership) !== JSON.stringify(ownership)
      ) {
        retired = true;
        throw new McpConnectionAuthorityError("retired");
      }
      const before = targets.map((target) => readAuthProfileRowsIdentity(target.databasePath));
      const publishers = targets.map((target) => target.observation.prepareRead());
      const rows = await Promise.all(
        targets.map(async (target) => {
          if (target.agentId === undefined) {
            return readSharedAuthProfileRows(context);
          }
          target.reader ??= prepareAgentAuthProfileRowsRead({
            databasePath: target.databasePath,
            agentId: target.agentId,
            env,
          });
          return target.reader.read();
        }),
      );
      assertOwners();
      for (let index = 0; index < targets.length; index++) {
        if (readAuthProfileRowsIdentity(targets[index]!.databasePath) !== before[index]) {
          throw new McpConnectionAuthorityError("unavailable");
        }
      }
      const stores = rows.map((row, index) => {
        const target = targets[index]!;
        const store = loadPersistedAuthProfileStoreFromRows(row, target.databasePath) ?? {
          version: AUTH_STORE_VERSION,
          profiles: {},
        };
        assertAuthProfileMigrationCandidates({
          databasePath: target.databasePath,
          candidates: resolveLegacyAuthProfileSourceCandidates({ agentDir: target.agentDir, env }),
          hasCredentials: () => Object.keys(store.profiles).length > 0,
          provider: store.profiles[profileId]?.provider,
          config: cfg,
        });
        publishers[index]!(row.store.status === "readable" ? row.store.raw : undefined);
        return store;
      });
      const local = stores[0]!;
      const shared = stores[paths.indexOf(sharedPath)]!;
      const effective = mergeLocalAuthProfileStoreWithInheritedStore(
        local,
        requestedPath === sharedPath ? undefined : shared,
      );
      const selected = effective.profiles[profileId];
      if (!Object.hasOwn(effective.profiles, profileId) || !selected) {
        retired = true;
        throw new McpConnectionAuthorityError("retired");
      }
      // Legacy reconciliation can replace a local profile with the shared credential.
      const selectedPath =
        selected === local.profiles[profileId] &&
        effective.runtimeLocalProfileIds?.includes(profileId)
          ? requestedPath
          : sharedPath;
      const lineagePaths =
        selectedPath === requestedPath && selected.type !== "oauth" ? [requestedPath] : paths;
      return { rows, selectedPath, lineagePaths };
    };
    const assertFacts = (allowPending = false) => {
      assertOwners();
      for (const target of targets) {
        if (!target.incarnation) {
          continue;
        }
        const fact = target.observation.readFact();
        if (!fact || fact.incarnation !== target.incarnation) {
          retired = true;
          throw new McpConnectionAuthorityError("retired");
        }
        if (target.databasePath === selectedPath) {
          if (
            fact.status === "retired" ||
            fact.status === "absent" ||
            (fact.expires !== undefined && fact.expires <= Date.now())
          ) {
            retired = true;
            throw new McpConnectionAuthorityError("retired");
          }
          if (fact.status === "pending" && !allowPending) {
            throw new McpConnectionAuthorityError("unavailable");
          }
        }
      }
    };
    let initial = await readCanonical();
    const enrollment = initial.rows.flatMap(({ store }, index) =>
      initial.lineagePaths.includes(targets[index]!.databasePath) &&
      !readAuthProfileAuthorizationLifetime(
        store.status === "readable" ? store.raw : undefined,
        profileId,
      )
        ? [{ target: targets[index]!, store }]
        : [],
    );
    if (enrollment.length) {
      // Release absent-file readers before the actual agent owner creates its first-use row.
      await closeReaders();
      for (const { target, store } of enrollment) {
        await enrollOwnedAuthProfileAuthorization({
          databasePath: target.databasePath,
          agentId: target.agentId,
          env,
          context,
          input: { profileId, expected: store },
          assertCurrent: assertRoot,
        });
        assertRoot();
      }
      initial = await readCanonical();
    }
    const selectedPath = initial.selectedPath;
    const lineage = targets.filter((target) => initial.lineagePaths.includes(target.databasePath));
    for (const target of lineage) {
      target.incarnation = target.observation.readFact()?.incarnation;
      if (!target.incarnation) {
        throw new McpConnectionAuthorityError("unavailable");
      }
    }
    assertFacts();
    // Hash only opaque owner-issued incarnations, never credential or token material.
    const authorizationId = createHash("sha256")
      .update(
        JSON.stringify([
          "mcp-auth-profile-v1",
          profileId,
          selectedPath,
          ...lineage.map((target) => [target.databasePath, target.incarnation]),
        ]),
      )
      .digest("hex");
    let observation: "ready" | "pending" | "unavailable" = "ready";
    return {
      authorizationId,
      assertCurrent() {
        assertFacts();
        // Canonical observation happens in revalidate; commit checks consume owner publications
        // without probing the WAL being written by this very admission.
        if (observation !== "ready") {
          throw new McpConnectionAuthorityError("unavailable");
        }
      },
      async revalidate() {
        assertFacts(true);
        if (observation === "pending") {
          throw new McpConnectionAuthorityError("unavailable");
        }
        observation = "pending";
        try {
          const current = await readCanonical();
          assertFacts();
          if (current.selectedPath !== selectedPath) {
            retired = true;
            throw new McpConnectionAuthorityError("retired");
          }
          observation = "ready";
        } catch (error) {
          observation = "unavailable";
          // An in-flight reader may reject on cleanup before it can return a row.
          // Known source retirement takes precedence over a transient read failure.
          assertRoot();
          throw sanitize(error);
        }
      },
      dispose() {
        if (disposed) {
          return;
        }
        release();
        void trackAsyncWork(closeReaders).catch(() => {
          authProfilesLog.warn("MCP auth-profile reader cleanup failed");
        });
      },
    };
  } catch (error) {
    try {
      await cleanup?.();
    } catch (cleanupError) {
      throw sanitize(cleanupError);
    }
    throw sanitize(error);
  }
}
