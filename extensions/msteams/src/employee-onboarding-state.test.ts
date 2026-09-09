// Msteams tests cover employee onboarding request plugin state persistence.
import {
  resetPluginStateStoreForTests,
  createPluginStateKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MSTEAMS_EMPLOYEE_ONBOARDING_REQUESTS_NAMESPACE,
  createMSTeamsEmployeeOnboardingRequestStoreState,
} from "./employee-onboarding-state.js";
import {
  createMSTeamsEmployeeOnboardingRequest,
  redactMSTeamsEmployeeOnboardingRequest,
  type MSTeamsEmployeeOnboardingRequest,
} from "./employee-onboarding.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

describe("msteams employee onboarding request state store", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("creates a pending request once and preserves the first request on repeat upsert", async () => {
    const store = createMSTeamsEmployeeOnboardingRequestStoreState();
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      senderName: "Second Employee",
      conversationId: "19:second@thread.v2",
      now: new Date("2026-08-20T14:55:00.000Z"),
    });

    const first = await store.upsertRequest(request);
    const second = await store.upsertRequest({
      ...request,
      senderName: "Updated Name",
      requestedAt: "2026-08-20T14:56:00.000Z",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request).toEqual(request);
    await expect(store.getRequest?.(request.id)).resolves.toEqual(request);
    await expect(store.listRequests?.()).resolves.toEqual([request]);
  });

  it("stores recoverable route data while keeping keys and public projection redacted", async () => {
    const store = createMSTeamsEmployeeOnboardingRequestStoreState();
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:transition-employee",
      senderName: "Second Employee",
      conversationId: "19:transition@thread.v2",
    });

    await store.upsertRequest(request);

    const rawStore = createPluginStateKeyedStoreForTests<MSTeamsEmployeeOnboardingRequest>(
      "msteams",
      {
        namespace: MSTEAMS_EMPLOYEE_ONBOARDING_REQUESTS_NAMESPACE,
        maxEntries: 5000,
      },
    );
    const rows = await rawStore.entries();
    const row = rows.find((entry) => entry.key === request.id);
    expect(row).toBeTruthy();
    expect(row?.key).not.toContain("29:transition-employee");
    expect(row?.value.protectedRoute).toEqual({
      peerId: "29:transition-employee",
      conversationId: "19:transition@thread.v2",
    });
    expect(JSON.stringify(redactMSTeamsEmployeeOnboardingRequest(row!.value))).not.toContain(
      "29:transition-employee",
    );
    expect(JSON.stringify(redactMSTeamsEmployeeOnboardingRequest(row!.value))).not.toContain(
      "19:transition@thread.v2",
    );
  });

  it("transitions a pending request once and keeps protected data redacted", async () => {
    const store = createMSTeamsEmployeeOnboardingRequestStoreState();
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      senderName: "Second Employee",
      conversationId: "19:second@thread.v2",
    });
    await store.upsertRequest(request);

    const result = await store.transitionRequest?.(request.id, {
      status: "provisioned",
      transitionedAt: "2026-08-25T20:20:00.000Z",
      transitionReason: "contains raw 29:second-employee route proof",
      transitionEvidence: {
        operator: "employee-onboarding-admin",
        requestId: request.id,
        peerHash: request.peerHash,
        agentIdHash: "agent-hash",
        stackNameHash: "stack-hash",
        routeProofHash: "route-hash",
        serviceProofHash: "service-hash",
      },
    });

    expect(result).toMatchObject({
      status: "transitioned",
      sideEffects: ["employee-onboarding-request-transition"],
      request: {
        status: "provisioned",
        transitionedAt: "2026-08-25T20:20:00.000Z",
      },
    });
    await expect(store.getRequest?.(request.id)).resolves.toMatchObject({
      status: "provisioned",
      transitionEvidence: {
        peerHash: request.peerHash,
        routeProofHash: "route-hash",
      },
    });
    const redacted = JSON.stringify(
      redactMSTeamsEmployeeOnboardingRequest((await store.getRequest?.(request.id))!),
    );
    expect(redacted).not.toContain("29:second-employee");
    expect(redacted).not.toContain("19:second@thread.v2");
    expect(redacted).not.toContain("contains raw");
  });

  it("allows idempotent same-evidence replay and blocks conflicting transitions", async () => {
    const store = createMSTeamsEmployeeOnboardingRequestStoreState();
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:idempotent-employee",
      conversationId: "19:idempotent@thread.v2",
    });
    const transition = {
      status: "failed" as const,
      transitionedAt: "2026-08-25T20:25:00.000Z",
      failureCode: "stack-config-failed",
      transitionEvidence: {
        operator: "employee-onboarding-admin" as const,
        requestId: request.id,
        peerHash: request.peerHash,
      },
    };
    await store.upsertRequest(request);

    await expect(store.transitionRequest?.(request.id, transition)).resolves.toMatchObject({
      status: "transitioned",
    });
    await expect(store.transitionRequest?.(request.id, transition)).resolves.toMatchObject({
      status: "idempotent",
    });
    await expect(
      store.transitionRequest?.(request.id, {
        ...transition,
        transitionEvidence: {
          ...transition.transitionEvidence,
          routeProofHash: "different-route-proof",
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "conflicting-transition",
      sideEffects: [],
    });
    await expect(
      store.transitionRequest?.(request.id, {
        ...transition,
        status: "rolled_back",
        transitionEvidence: {
          ...transition.transitionEvidence,
          rollbackProofHash: "rollback-proof",
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "request-not-pending",
      sideEffects: [],
    });
  });
});
