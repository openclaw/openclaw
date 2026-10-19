import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { GatewayRetainedWorkScope } from "../../shared/async-work-scope.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { WorkspaceStateGuard } from "../workspace-state-store.worker-contract.js";
import { withSandboxRegistryPublication } from "./registry-publication.js";
import type { SandboxRegistryEntry } from "./registry.types.js";

const lifetimes = new Map<string, ReturnType<typeof createLifetime>>();

function createLifetime({ admission }: OpenClawStateWorkerContext) {
  const key = admission.identity.canonicalPath;
  const work = new GatewayRetainedWorkScope();
  const owner = {
    retainGateway: () => work.retainGateway(),
    run<T>(run: () => Promise<T>): Promise<T> {
      if (work.isClosing) {
        return Promise.reject(new Error("Sandbox registry admission is closed"));
      }
      // Accepted removal owns its persistence signal across scheduler cancellation.
      return work.scope.track(run);
    },
  };
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (
        !identity ||
        identity.key === admission.identity.key ||
        identity.canonicalPath === admission.identity.canonicalPath
      ) {
        await work.beginDrainAll();
        if (work.hasGateways) {
          // Read admission may retire while the Gateway still owns the close prelude.
          work.reopen();
        } else {
          lifetimes.delete(key);
          unregister();
        }
      }
    },
  });
  return owner;
}

function lifetime(context: OpenClawStateWorkerContext) {
  const key = context.admission.identity.canonicalPath;
  let owner = lifetimes.get(key);
  if (!owner) {
    owner = createLifetime(context);
    lifetimes.set(key, owner);
  }
  return owner;
}

export function withSandboxRegistrySettlement<T>(
  context: OpenClawStateWorkerContext,
  run: () => Promise<T>,
): Promise<T> {
  context.admission.assertCurrent();
  return lifetime(context).run(run);
}

export function prepareSandboxRegistryClose() {
  return lifetime(captureOpenClawStateWorkerContext()).retainGateway();
}

/** Provider-confirmed removal keeps only exact terminal cleanup authority after read admission closes. */
export async function finishSandboxRegistryRemoval(
  context: OpenClawStateWorkerContext,
  identity: DatabasePathIdentity,
  entry: SandboxRegistryEntry,
  guard?: WorkspaceStateGuard,
): Promise<void> {
  const { openOpenClawStateWorkerCleanupStore } =
    await import("../../state/openclaw-state-worker-store.js");
  const { createSqliteWorkerWriteAdmission, runSqliteWorkerStoreOperation } =
    await import("../../infra/sqlite-worker-store.js");
  const cleanupContext = {
    environment: context.environment,
    existingSchemaPath: context.existingSchemaPath,
    stateIntegrity: context.stateIntegrity,
  };
  let active = true;
  const assertOwned = () => {
    if (!active) {
      throw new Error("Sandbox registry removal has settled");
    }
    guard?.assertHost?.();
  };
  guard?.beforeLegacyApply?.();
  const store = await openOpenClawStateWorkerCleanupStore(
    context.admission.databasePath,
    cleanupContext,
    assertOwned,
    identity,
    context.maintenanceScope,
  );
  if (!store) {
    throw new Error("Sandbox removal lost its original shared database");
  }
  const errors: unknown[] = [];
  try {
    await runSqliteWorkerStoreOperation(
      store,
      (scope) => scope.execute({ type: "sandboxRegistry.finishRemoval", input: entry }),
      cleanupContext,
      assertOwned,
      withSandboxRegistryPublication(
        createSqliteWorkerWriteAdmission(assertOwned, [context.admission.databasePath]),
        () => identity.key,
        assertOwned,
      ),
    );
  } catch (error) {
    errors.push(error);
  }
  try {
    await store.close();
  } catch (error) {
    errors.push(error);
  } finally {
    active = false;
  }
  throwSqliteLifecycleErrors(errors, "Sandbox removal settlement and worker cleanup failed");
}
