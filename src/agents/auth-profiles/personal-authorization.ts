import { createHash } from "node:crypto";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { capturePersonalCredentialAuthority } from "../../state/user-model-account-authority.js";
import { enrollPersonalAuthProfileAuthorizationAsync } from "../../state/user-model-account-operations.js";
import {
  AuthProfileAuthorizationError,
  type AuthProfileAuthorization,
} from "./authorization-contract.js";
import { assertPersonalAuthProfileRuntime } from "./runtime-scope.js";

/** Capture the private account owner's lifetime without exposing or copying bearer material. */
export async function capturePersonalAuthProfileAuthorization(
  params: { profileId: string; assertCurrent: () => void },
  options: { context?: OpenClawStateWorkerContext } = {},
): Promise<AuthProfileAuthorization> {
  const sanitize = (error: unknown) =>
    error instanceof AuthProfileAuthorizationError
      ? error
      : new AuthProfileAuthorizationError("unavailable");
  let disposed = false;
  let retired = false;
  const assertSource = () => {
    if (disposed || retired) {
      throw new AuthProfileAuthorizationError("retired");
    }
    try {
      params.assertCurrent();
      assertPersonalAuthProfileRuntime();
    } catch {
      retired = true;
      throw new AuthProfileAuthorizationError("retired");
    }
  };
  try {
    assertPersonalAuthProfileRuntime();
    assertSource();
    const context = options.context ?? captureOpenClawStateWorkerContext();
    const assertOwner = () => {
      assertSource();
      try {
        context.admission.assertCurrent();
        context.maintenanceScope?.assertAdmission();
      } catch {
        retired = true;
        throw new AuthProfileAuthorizationError("retired");
      }
    };
    const authority = await capturePersonalCredentialAuthority(context, params.profileId);
    const readCanonical = async () => {
      assertOwner();
      const reply = await executeExistingOpenClawStateRead(
        { path: context.admission.databasePath, env: context.environment },
        { type: "userModelAccounts.authorization", authProfileId: params.profileId },
        { context, current: true, preferIndependentWarmRead: true },
      );
      assertOwner();
      return reply?.authorization;
    };
    let initial = await readCanonical();
    if (initial && !initial.authorizationId) {
      initial = await enrollPersonalAuthProfileAuthorizationAsync(
        { profileId: params.profileId, assertCurrent: assertOwner },
        { context },
      );
      assertOwner();
    }
    if (!initial?.authorizationId) {
      throw new AuthProfileAuthorizationError("retired");
    }
    const { authorizationId: lifetime, ownerProfileId } = initial;
    authority.observeAuthorizationId(lifetime);
    let observation: "ready" | "pending" | "unavailable" = "ready";
    const assertFacts = () => {
      assertOwner();
      authority.assertAuthorizationCurrent(lifetime);
    };
    assertFacts();
    // Ownership transfer retires a binding even though merge preserves the private record.
    const authorizationId = createHash("sha256")
      .update(
        JSON.stringify(["personal-auth-profile-v1", params.profileId, ownerProfileId, lifetime]),
      )
      .digest("hex");
    return {
      authorizationId,
      assertCurrent() {
        assertFacts();
        if (observation !== "ready") {
          throw new AuthProfileAuthorizationError("unavailable");
        }
      },
      async revalidate() {
        assertFacts();
        if (observation === "pending") {
          throw new AuthProfileAuthorizationError("unavailable");
        }
        observation = "pending";
        try {
          const current = await readCanonical();
          if (current?.authorizationId !== lifetime || current.ownerProfileId !== ownerProfileId) {
            retired = true;
            throw new AuthProfileAuthorizationError("retired");
          }
          assertFacts();
          observation = "ready";
        } catch (error) {
          observation = "unavailable";
          throw sanitize(error);
        }
      },
      dispose() {
        disposed = true;
      },
    };
  } catch (error) {
    throw sanitize(error);
  }
}
