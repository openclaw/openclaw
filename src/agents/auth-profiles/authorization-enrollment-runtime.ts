import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type {
  AuthProfileAuthorizationEnrollment,
  AuthProfileAuthorizationOperations,
} from "./authorization-enrollment.js";
import { fenceAuthProfileAuthorizationWrite } from "./authorization-observation.js";

/** Uses the existing agent executor/shared actor, including native transaction/commit guards. */
export async function enrollOwnedAuthProfileAuthorization(params: {
  databasePath: string;
  agentId?: string;
  env: NodeJS.ProcessEnv;
  context: OpenClawStateWorkerContext;
  input: AuthProfileAuthorizationEnrollment;
  assertCurrent: () => void;
}): Promise<void> {
  const { databasePath, assertCurrent } = params;
  let settle: ReturnType<typeof fenceAuthProfileAuthorizationWrite> | undefined;
  let receipt:
    | AuthProfileAuthorizationOperations["authProfiles.enrollAuthorization"]["output"]
    | undefined;
  let settled: Promise<void> | undefined;
  try {
    if (params.agentId === undefined) {
      const factory = createSqliteWorkerWriteAdmission(
        (request) => {
          assertCurrent();
          if (request.stage === "commit") {
            settle ??= fenceAuthProfileAuthorizationWrite(databasePath);
          }
        },
        [databasePath],
      );
      receipt = await runOpenClawStateWorkerOperation(
        params.context,
        (scope) => scope.execute({ type: "authProfiles.enrollAuthorization", input: params.input }),
        {
          assertCurrent,
          createAdmission(retained) {
            const binding = factory(retained);
            settled = retained.settled.then((outcome) => {
              // Enrollment preserves credentials; only unknown settlement invalidates old facts.
              settle?.(outcome.kind !== "unknown");
            });
            return binding;
          },
        },
      );
    } else {
      const options = { agentId: params.agentId, path: databasePath, env: params.env };
      const execution = captureOpenClawAgentDatabaseExecution(options);
      try {
        await execution.prepare({
          assertCurrent,
          createAdmission(binding) {
            return () => ({
              nativeLocations: binding.nativeLocations,
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                assertCurrent();
                binding.authorize(request);
                if (!grant()) {
                  throw new Error("Auth profile enrollment lost admission");
                }
              }, binding.attachment),
            });
          },
        });
        assertCurrent();
        const worker = await openOpenClawAgentSqliteWorkerStore<AuthProfileAuthorizationOperations>(
          options,
          { execution },
          {
            moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.authProfileInlineUsage),
            input: {},
            assertAdmission(request) {
              assertCurrent();
              if (request.stage === "commit") {
                settle ??= fenceAuthProfileAuthorizationWrite(databasePath);
              }
              return request;
            },
          },
        );
        try {
          receipt = await worker.execute(
            { type: "authProfiles.enrollAuthorization", input: params.input },
            assertCurrent,
          );
          settle?.(true, receipt.raw);
        } finally {
          await worker.close();
        }
      } finally {
        await execution.release();
      }
    }
  } finally {
    await settled;
    // A result-delivery failure after a commit grant is not a confirmed rollback.
    settle?.(receipt !== undefined, receipt?.raw);
  }
}
