import { expect, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as publication from "./runtime-snapshot-publication.js";

type ExpectedOAuthCredentialFields = {
  provider: string;
  access?: string;
  refresh?: string;
  idToken?: string;
  expires?: number;
  email?: string;
  accountId?: string;
  chatgptPlanType?: string;
};

type AuthProfileTestState = {
  stateDir: string;
  agentDir: string;
  agentDirFor: (agentId: string) => string;
};

export async function withAuthProfileTestState<T>(
  prefix: string,
  run: (state: AuthProfileTestState) => Promise<T> | T,
  options: { clearOAuthDir?: boolean } = {},
): Promise<T> {
  return withOpenClawTestState(
    {
      prefix,
      layout: "state-only",
      env: options.clearOAuthDir ? { OPENCLAW_OAUTH_DIR: undefined } : undefined,
    },
    async (state) =>
      run({ stateDir: state.stateDir, agentDir: state.agentDir(), agentDirFor: state.agentDir }),
  );
}

export function expectOAuthCredentialFields(
  value: unknown,
  expected: ExpectedOAuthCredentialFields,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Expected OAuth credential object");
  }
  const credential = value as Record<string, unknown>;
  expect(credential.type).toBe("oauth");
  expect(credential.provider).toBe(expected.provider);
  for (const field of [
    "access",
    "refresh",
    "idToken",
    "expires",
    "email",
    "accountId",
    "chatgptPlanType",
  ] as const) {
    if (field in expected) {
      expect(credential[field]).toBe(expected[field]);
    }
  }
  return credential;
}

export function failNextRuntimeAuthSnapshotPublication() {
  const publish = publication.publishPreparedRuntimeAuthProfileStoreSnapshot;
  return vi
    .spyOn(publication, "publishPreparedRuntimeAuthProfileStoreSnapshot")
    .mockImplementationOnce((...args) => {
      publish(...args);
      throw new Error("injected postcommit publication failure");
    });
}
