// Msteams tests cover dry-run employee onboarding provisioning plans.
import { describe, expect, it } from "vitest";
import {
  createMSTeamsEmployeeOnboardingProvisioningDryRun,
  createMSTeamsEmployeeOnboardingProvisioningDryRunFromStore,
  createMSTeamsEmployeeOnboardingExecutionReadinessProof,
  createMSTeamsEmployeeOnboardingAdminTransition,
  createMSTeamsEmployeeOnboardingAdminDryRun,
  redactMSTeamsEmployeeOnboardingExecutionReadinessProof,
  redactMSTeamsEmployeeOnboardingProvisioningDryRun,
  renderMSTeamsEmployeeOnboardingProvisioningStack,
  resolveMSTeamsEmployeeOnboardingImageApproval,
} from "./employee-onboarding-provisioning.js";
import { createMSTeamsEmployeeOnboardingRequest } from "./employee-onboarding.js";

describe("msteams employee onboarding provisioning dry run", () => {
  function createReadyDryRun() {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      senderName: "Second Employee",
      conversationId: "19:second@thread.v2",
      now: new Date("2026-08-20T16:10:00.000Z"),
    });
    const dryRun = createMSTeamsEmployeeOnboardingProvisioningDryRun({
      request,
      image: "local/openclaw-gateway:2026.8.1",
      employee: {
        displayName: "Second Employee",
        email: "second.employee@example.com",
        desiredSlug: "second-pilot",
        manager: "Kevin K",
        dataScope: "pilot employee workspace only",
      },
    });
    if (dryRun.status !== "ready") {
      throw new Error(`expected ready dry run, got ${dryRun.status}`);
    }
    return dryRun;
  }

  it("renders an actionable employee-agent plan from a pending Teams request without side effects", () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      senderName: "Second Employee",
      conversationId: "19:second@thread.v2",
      now: new Date("2026-08-20T16:10:00.000Z"),
    });

    const dryRun = createMSTeamsEmployeeOnboardingProvisioningDryRun({
      request,
      image: "local/openclaw-gateway:2026.8.1",
      employee: {
        displayName: "Second Employee",
        email: "second.employee@example.com",
        desiredSlug: "second-pilot",
        manager: "Kevin K",
        dataScope: "pilot employee workspace only",
      },
    });

    expect(dryRun).toMatchObject({
      dryRun: true,
      status: "ready",
      sideEffects: [],
      approvalRequired: true,
      employee: {
        displayName: "Second Employee",
        email: "second.employee@example.com",
        slug: "second-pilot",
        manager: "Kevin K",
        dataScope: "pilot employee workspace only",
        permissionTier: "employee-standard-v1",
      },
      proposed: {
        agentId: "second-pilot",
        stackName: "employee-agent-second-pilot",
        serviceName: "employee-agent-second-pilot",
        image: "local/openclaw-gateway:2026.8.1",
        memoryScope: "employee-agent-second-pilot",
        secretRef: "employee_agent_second_pilot_token_v1",
        bws: {
          employeeProjectName: "openclaw-second-pilot",
          sharedConnectorProjectName: "openclaw-employee-connectors",
          machineAccountName: "openclaw-employee-second-pilot",
          tokenSecretRef: "employee_agent_second_pilot_bws_token_v1",
          accessTokenFile: "/run/secrets/employee_bws_access_token",
          resolverPath: "/home/openclaw/config/openclaw-bws-resolver.mjs",
          providerAlias: "bws",
          requiredProjectAccess: ["openclaw-second-pilot", "openclaw-employee-connectors"],
          sharedConnectorSecretKeys: [
            "openclaw/connectors/salesforce/sfdxAuthJson",
            "openclaw/connectors/salesforce/defaultTargetOrg",
            "openclaw/connectors/krisp/oauthStoreJson",
            "openclaw/connectors/krisp/mcpServerConfig",
            "openclaw/connectors/krisp/serviceIdentity",
          ],
        },
        paths: {
          root: "/srv/openclaw/data/employee-agents/second-pilot",
          config: "/srv/openclaw/data/employee-agents/second-pilot/config",
          state: "/srv/openclaw/data/employee-agents/second-pilot/state/.openclaw",
          workspace: "/srv/openclaw/data/employee-agents/second-pilot/workspace",
          stackFile: "/srv/openclaw/stacks/employee-agent-second-pilot/stack.yml",
        },
        environment: {
          OPENCLAW_AGENT_OWNER: "second-pilot",
          OPENCLAW_DISABLED_CHANNELS: "telegram",
          OPENCLAW_PRIMARY_CHANNEL: "msteams",
          OPENCLAW_TOOL_POLICY: "employee-standard-v1",
          BWS_ACCESS_TOKEN_FILE: "/run/secrets/employee_bws_access_token",
        },
        routeBinding: {
          type: "route",
          agentId: "second-pilot",
          match: {
            channel: "msteams",
            accountId: "default",
            peer: {
              kind: "direct",
              id: "29:second-employee",
            },
          },
        },
      },
    });
    expect(dryRun.status).toBe("ready");
    if (dryRun.status !== "ready") {
      return;
    }
    expect(dryRun.commands.createAgent).toContain("openclaw agents add 'second-pilot'");
    expect(dryRun.commands.bindTeamsRoute).toContain("--peer-id '29:second-employee'");
    expect(dryRun.commands.deployStack).toContain("employee-agent-second-pilot");
    expect(dryRun.validation).toContain("Kevin Teams direct peer still routes to kevin-k");
    expect(dryRun.validation).toContain(
      "employee BWS token sees the employee project and shared connector project required for its scope",
    );
  });

  it("allows onboarding to bind a pre-created employee BWS project name", () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:kevin",
      senderName: "Kevin Kilgo",
      conversationId: "19:kevin@thread.v2",
      now: new Date("2026-09-09T15:20:00.000Z"),
    });

    const dryRun = createMSTeamsEmployeeOnboardingProvisioningDryRun({
      request,
      image: "local/openclaw-gateway:2026.8.1",
      employee: {
        displayName: "Kevin Kilgo",
        email: "kkilgo@example.com",
        desiredSlug: "kkilgo",
        bwsProjectName: "openclaw-kevin-kilgo",
      },
    });

    expect(dryRun.status).toBe("ready");
    if (dryRun.status !== "ready") {
      return;
    }
    expect(dryRun.proposed.bws).toMatchObject({
      employeeProjectName: "openclaw-kevin-kilgo",
      sharedConnectorProjectName: "openclaw-employee-connectors",
      machineAccountName: "openclaw-employee-kkilgo",
      requiredProjectAccess: ["openclaw-kevin-kilgo", "openclaw-employee-connectors"],
    });
  });

  it("redacts protected Teams route data for public dry-run output", () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:second@thread.v2",
    });
    const dryRun = createMSTeamsEmployeeOnboardingProvisioningDryRun({
      request,
      image: "local/openclaw-gateway:2026.8.1",
      employee: {
        displayName: "Second Employee",
        email: "second.employee@example.com",
      },
    });

    const redacted = redactMSTeamsEmployeeOnboardingProvisioningDryRun(dryRun);

    expect(JSON.stringify(redacted)).not.toContain("29:second-employee");
    expect(JSON.stringify(redacted)).not.toContain("19:second@thread.v2");
    expect(JSON.stringify(redacted)).toContain(request.peerHash);
    expect(JSON.stringify(redacted)).toContain("<protected>");
  });

  it("blocks legacy hash-only pending requests because exact Teams binding is not recoverable", () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:second@thread.v2",
    });
    const { protectedRoute: _protectedRoute, ...legacyRequest } = request;

    const dryRun = createMSTeamsEmployeeOnboardingProvisioningDryRun({
      request: legacyRequest as typeof request,
      image: "local/openclaw-gateway:2026.8.1",
      employee: {
        displayName: "Second Employee",
        email: "second.employee@example.com",
      },
    });

    expect(dryRun).toEqual({
      dryRun: true,
      status: "blocked",
      requestId: request.id,
      reason: "missing-protected-route",
      message:
        "Pending request does not include protected Teams route data; exact direct-peer binding cannot be created.",
      sideEffects: [],
    });
  });

  it("consumes a pending request from the store for dry-run provisioning", async () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:second@thread.v2",
    });
    const dryRun = await createMSTeamsEmployeeOnboardingProvisioningDryRunFromStore({
      requestId: request.id,
      store: {
        getRequest: async (requestId) => (requestId === request.id ? request : null),
      },
      image: "local/openclaw-gateway:2026.8.1",
      employee: {
        displayName: "Second Employee",
        email: "second.employee@example.com",
        desiredSlug: "second-pilot",
      },
    });

    expect(dryRun.status).toBe("ready");
    if (dryRun.status !== "ready") {
      return;
    }
    expect(dryRun.proposed.routeBinding.match.peer.id).toBe("29:second-employee");
  });

  it("blocks when the requested pending record is missing", async () => {
    const dryRun = await createMSTeamsEmployeeOnboardingProvisioningDryRunFromStore({
      requestId: "missing",
      store: {
        getRequest: async () => null,
      },
      image: "local/openclaw-gateway:2026.8.1",
      employee: {
        displayName: "Second Employee",
        email: "second.employee@example.com",
      },
    });

    expect(dryRun).toEqual({
      dryRun: true,
      status: "blocked",
      requestId: "missing",
      reason: "missing-request",
      message: "Pending Teams employee onboarding request was not found.",
      sideEffects: [],
    });
  });

  it("blocks when the target employee-agent image is not explicitly supplied", () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:second@thread.v2",
    });

    const dryRun = createMSTeamsEmployeeOnboardingProvisioningDryRun({
      request,
      image: "   ",
      employee: {
        displayName: "Second Employee",
        email: "second.employee@example.com",
      },
    });

    expect(dryRun).toEqual({
      dryRun: true,
      status: "blocked",
      requestId: request.id,
      reason: "missing-target-image",
      message:
        "Target employee-agent image is required; derive it from the active release/config or approved target-host image before execution.",
      sideEffects: [],
    });
  });

  it("renders an unpublished host-backed stack from the proposed scaffold paths", () => {
    const dryRun = createReadyDryRun();

    const stack = renderMSTeamsEmployeeOnboardingProvisioningStack(dryRun);

    expect(stack).toMatchObject({
      serviceName: "employee-agent-second-pilot",
      image: "local/openclaw-gateway:2026.8.1",
      ports: [],
    });
    expect(stack.volumes).toEqual([
      {
        type: "bind",
        source: "/srv/openclaw/data/employee-agents/second-pilot/config",
        target: "/home/openclaw/config",
        readOnly: true,
      },
      {
        type: "bind",
        source: "/srv/openclaw/data/employee-agents/second-pilot/state/.openclaw",
        target: "/home/openclaw/.openclaw",
      },
      {
        type: "bind",
        source: "/srv/openclaw/data/employee-agents/second-pilot/workspace",
        target: "/home/openclaw/workspace",
      },
      {
        type: "bind",
        source: "/srv/openclaw/data/employee-agents/second-pilot/shared/artifacts",
        target: "/shared/artifacts",
      },
      {
        type: "bind",
        source: "/srv/openclaw/data/employee-agents/second-pilot/shared/task-inputs",
        target: "/shared/task-inputs",
        readOnly: true,
      },
      {
        type: "bind",
        source: "/srv/openclaw/data/employee-agents/second-pilot/shared/task-results",
        target: "/shared/task-results",
      },
    ]);
  });

  it("builds execution readiness proof with idempotent actions, validation, and rollback", () => {
    const dryRun = createReadyDryRun();

    const proof = createMSTeamsEmployeeOnboardingExecutionReadinessProof({
      plan: dryRun,
      image: resolveMSTeamsEmployeeOnboardingImageApproval({
        candidateImage: "local/openclaw-gateway:2026.8.1",
        activeRuntimeVersion: "2026.8.1",
      }),
      existing: {
        agentExists: true,
        routeExists: false,
        stackExists: true,
        scaffoldPathExists: {
          root: true,
          config: true,
          state: true,
          workspace: true,
          artifacts: false,
          taskInputs: false,
          taskResults: false,
        },
      },
    });

    expect(proof).toMatchObject({
      dryRun: true,
      status: "ready",
      blockers: [],
      idempotency: {
        agent: "skip-existing",
        route: "create",
        stack: "update-existing",
        scaffold: {
          root: "reuse-existing",
          config: "reuse-existing",
          state: "reuse-existing",
          workspace: "reuse-existing",
          artifacts: "create",
          taskInputs: "create",
          taskResults: "create",
        },
      },
      image: resolveMSTeamsEmployeeOnboardingImageApproval({
        candidateImage: "local/openclaw-gateway:2026.8.1",
        activeRuntimeVersion: "2026.8.1",
      }),
      hostBackedMounts: {
        missing: [],
        passed: true,
      },
      ports: {
        published: [],
        passed: true,
      },
      approvalPacket: {
        required: true,
      },
    });
    expect(proof.routeValidation).toContain("new Teams direct peer resolves to the employee agent");
    expect(proof.containerValidation).toContain(
      "employee service endpoint ports inspect returns no published ports",
    );
    expect(proof.containerValidation).toContain(
      "employee BWS project access proof succeeds from inside the container",
    );
    expect(proof.approvalPacket.expectedChanges).toContain(
      "employee BWS project openclaw-second-pilot",
    );
    expect(proof.approvalPacket.expectedChanges).toContain(
      "read access to shared connector project openclaw-employee-connectors",
    );
    expect(proof.approvalPacket.rollbackProof).toContain(dryRun.commands.rollbackRoute);
  });

  it("blocks execution readiness when the target image is not approved", () => {
    const dryRun = createReadyDryRun();

    const proof = createMSTeamsEmployeeOnboardingExecutionReadinessProof({
      plan: dryRun,
      image: {
        image: "local/openclaw-gateway:2026.8.1",
        source: "target-host",
        approved: false,
      },
    });

    expect(proof.status).toBe("blocked");
    expect(proof.blockers).toEqual([
      "Target image is not approved: local/openclaw-gateway:2026.8.1",
    ]);
  });

  it("redacts protected Teams route data from execution approval proof", () => {
    const dryRun = createReadyDryRun();
    const proof = createMSTeamsEmployeeOnboardingExecutionReadinessProof({
      plan: dryRun,
      image: {
        image: "local/openclaw-gateway:2026.8.1",
        source: "active-release",
        approved: true,
      },
    });

    const redacted = redactMSTeamsEmployeeOnboardingExecutionReadinessProof(proof);

    expect(JSON.stringify(redacted)).not.toContain("29:second-employee");
    expect(JSON.stringify(redacted)).not.toContain("19:second@thread.v2");
    expect(redacted.approvalPacket.rollbackProof).toContain(
      "openclaw agents unbind --agent <slug> --bind msteams:<accountId> --peer-kind direct --peer-id <protected> --json",
    );
    expect(redacted.approvalPacket.rollbackProof).toContain(dryRun.commands.rollbackStack);
  });

  it("runs an operator admin dry run against a pending request and emits redacted approval proof", async () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:second@thread.v2",
      now: new Date("2026-08-20T19:10:00.000Z"),
    });

    const result = await createMSTeamsEmployeeOnboardingAdminDryRun({
      requestId: request.id,
      store: {
        getRequest: async (requestId) => (requestId === request.id ? request : null),
      },
      image: {
        image: "local/openclaw-gateway:2026.8.1",
        source: "active-release",
        approved: true,
      },
      existing: {
        agentExists: false,
        routeExists: false,
        stackExists: false,
      },
      employee: {
        displayName: "Second Employee",
        email: "second.employee@example.com",
        desiredSlug: "second-pilot",
      },
    });

    expect(result).toMatchObject({
      dryRun: true,
      mode: "operator-admin",
      status: "ready",
      requestId: request.id,
      sideEffects: [],
      plan: {
        dryRun: true,
        status: "ready",
        proposed: {
          routeBinding: {
            match: {
              peer: {
                id: "[protected]",
                hash: request.peerHash,
              },
            },
          },
        },
      },
      executionReadiness: {
        dryRun: true,
        status: "ready",
        approvalPacket: {
          required: true,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("29:second-employee");
    expect(JSON.stringify(result)).not.toContain("19:second@thread.v2");
  });

  it("resolves image approval from active runtime, config, or target-host inventory", () => {
    expect(
      resolveMSTeamsEmployeeOnboardingImageApproval({
        candidateImage: "local/openclaw-gateway:2026.8.1",
        activeRuntimeVersion: "2026.8.1",
      }),
    ).toMatchObject({
      image: "local/openclaw-gateway:2026.8.1",
      source: "active-release",
      approved: true,
      evidence: ["derived from active runtime version 2026.8.1"],
    });
    expect(
      resolveMSTeamsEmployeeOnboardingImageApproval({
        candidateImage: "local/openclaw-gateway:custom-approved",
        configuredImage: "local/openclaw-gateway:custom-approved",
      }),
    ).toMatchObject({
      source: "config",
      approved: true,
    });
    expect(
      resolveMSTeamsEmployeeOnboardingImageApproval({
        candidateImage: "local/openclaw-gateway:2026.8.1",
        targetHostImages: ["local/openclaw-gateway:2026.6.6", "local/openclaw-gateway:2026.8.1"],
      }),
    ).toMatchObject({
      source: "target-host",
      approved: true,
    });
  });

  it("blocks image approval when candidate image is not proven by evidence", () => {
    expect(
      resolveMSTeamsEmployeeOnboardingImageApproval({
        candidateImage: "local/openclaw-gateway:2026.6.6",
        activeRuntimeVersion: "2026.8.1",
        targetHostImages: ["local/openclaw-gateway:2026.8.1"],
      }),
    ).toMatchObject({
      image: "local/openclaw-gateway:2026.6.6",
      source: "target-host",
      approved: false,
      evidence: [
        "active runtime image would be local/openclaw-gateway:2026.8.1",
        "candidate image not present in target-host inventory",
      ],
    });
    expect(
      resolveMSTeamsEmployeeOnboardingImageApproval({
        candidateImage: "local/openclaw-gateway:2026.8.1",
        activeRuntimeVersion: "2026.8.1",
        targetHostImages: ["local/openclaw-gateway:2026.6.6"],
      }),
    ).toMatchObject({
      image: "local/openclaw-gateway:2026.8.1",
      source: "target-host",
      approved: false,
      evidence: [
        "active runtime image would be local/openclaw-gateway:2026.8.1",
        "candidate image not present in target-host inventory",
      ],
    });
  });

  it("keeps operator admin dry run blocked when readiness proof is blocked", async () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:second@thread.v2",
    });

    const result = await createMSTeamsEmployeeOnboardingAdminDryRun({
      requestId: request.id,
      store: {
        getRequest: async () => request,
      },
      image: {
        image: "local/openclaw-gateway:2026.8.1",
        source: "target-host",
        approved: false,
      },
      employee: {
        displayName: "Second Employee",
        email: "second.employee@example.com",
      },
    });

    expect(result.status).toBe("blocked");
    if (!("executionReadiness" in result)) {
      throw new Error("expected execution readiness proof");
    }
    expect(result.executionReadiness.blockers).toEqual([
      "Target image is not approved: local/openclaw-gateway:2026.8.1",
    ]);
  });

  it("blocks provisioned transition until route, stack, and service proof are green", async () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:second@thread.v2",
    });
    const transitions: unknown[] = [];

    const result = await createMSTeamsEmployeeOnboardingAdminTransition({
      requestId: request.id,
      status: "provisioned",
      store: {
        getRequest: async () => request,
        transitionRequest: async (_requestId, transition) => {
          transitions.push(transition);
          throw new Error("transition should not be called before proof is green");
        },
      },
      proof: {
        provisioningProofGreen: true,
        routeProof: "route-ok",
        stackProof: "stack-ok",
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "proof-not-green",
      sideEffects: [],
    });
    expect(transitions).toEqual([]);
  });

  it("transitions pending requests to provisioned with redacted hashed evidence", async () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:second@thread.v2",
    });
    let storedStatus = request.status;

    const result = await createMSTeamsEmployeeOnboardingAdminTransition({
      requestId: request.id,
      status: "provisioned",
      transitionedAt: "2026-08-25T20:45:00.000Z",
      transitionReason: "route/agent/stack proof green",
      store: {
        getRequest: async () => request,
        transitionRequest: async (_requestId, transition) => {
          storedStatus = transition.status;
          return {
            status: "transitioned",
            sideEffects: ["employee-onboarding-request-transition"],
            request: {
              ...request,
              status: transition.status,
              transitionedAt: transition.transitionedAt,
              transitionEvidence: transition.transitionEvidence,
            },
          };
        },
      },
      proof: {
        provisioningProofGreen: true,
        routeProof: "peer 29:second-employee resolves to employee",
        stackProof: "stack employee-agent-second-pilot validates",
        serviceProof: "employee-agent-second-pilot 1/1",
        runnerImage: "local/openclaw-provisioning-runner:test",
        agentId: "second-pilot",
        stackName: "employee-agent-second-pilot",
      },
    });

    expect(storedStatus).toBe("provisioned");
    expect(result).toMatchObject({
      mode: "operator-admin",
      status: "transitioned",
      requestStatus: "provisioned",
      sideEffects: ["employee-onboarding-request-transition"],
      transitionEvidence: {
        operator: "employee-onboarding-admin",
        requestId: request.id,
        peerHash: request.peerHash,
      },
    });
    expect(JSON.stringify(result)).not.toContain("29:second-employee");
    expect(JSON.stringify(result)).not.toContain("second-pilot");
    expect(JSON.stringify(result)).not.toContain("employee-agent-second-pilot");
  });

  it("supports linked, failed, and rolled-back terminal transitions with proof gates", async () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:second@thread.v2",
    });

    await expect(
      createMSTeamsEmployeeOnboardingAdminTransition({
        requestId: request.id,
        status: "linked",
        store: {
          getRequest: async () => request,
          transitionRequest: async () => {
            throw new Error("transition should not run without linked proof");
          },
        },
        proof: {
          routeProof: "existing route",
        },
      }),
    ).resolves.toMatchObject({ status: "blocked", reason: "proof-not-green" });

    for (const [status, proof, failureCode] of [
      ["linked", { linkedProofGreen: true, routeProof: "existing route proof" }, undefined],
      ["failed", {}, "stack-config-failed"],
      ["rolled_back", { rollbackProof: "route and stack removed" }, undefined],
    ] as const) {
      await expect(
        createMSTeamsEmployeeOnboardingAdminTransition({
          requestId: request.id,
          status,
          store: {
            getRequest: async () => request,
            transitionRequest: async (_requestId, transition) => ({
              status: "transitioned",
              sideEffects: ["employee-onboarding-request-transition"],
              request: {
                ...request,
                status: transition.status,
                transitionEvidence: transition.transitionEvidence,
                failureCode: transition.failureCode,
              },
            }),
          },
          proof,
          failureCode,
        }),
      ).resolves.toMatchObject({
        status: "transitioned",
        requestStatus: status,
        sideEffects: ["employee-onboarding-request-transition"],
      });
    }
  });

  it("returns idempotent replay and conflicting-transition blocks from the store", async () => {
    const request = createMSTeamsEmployeeOnboardingRequest({
      accountId: "default",
      senderId: "29:second-employee",
      conversationId: "19:second@thread.v2",
    });

    await expect(
      createMSTeamsEmployeeOnboardingAdminTransition({
        requestId: request.id,
        status: "provisioned",
        store: {
          getRequest: async () => request,
          transitionRequest: async () => ({
            status: "idempotent",
            sideEffects: ["employee-onboarding-request-transition"],
            request: {
              ...request,
              status: "provisioned",
            },
          }),
        },
        proof: {
          provisioningProofGreen: true,
          routeProof: "route-ok",
          stackProof: "stack-ok",
          serviceProof: "service-ok",
        },
      }),
    ).resolves.toMatchObject({
      status: "idempotent",
      sideEffects: ["employee-onboarding-request-transition"],
    });

    await expect(
      createMSTeamsEmployeeOnboardingAdminTransition({
        requestId: request.id,
        status: "provisioned",
        store: {
          getRequest: async () => request,
          transitionRequest: async () => ({
            status: "blocked",
            reason: "conflicting-transition",
            message: "conflicting transition",
            sideEffects: [],
          }),
        },
        proof: {
          provisioningProofGreen: true,
          routeProof: "route-ok",
          stackProof: "stack-ok",
          serviceProof: "service-ok",
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "conflicting-transition",
      sideEffects: [],
    });
  });
});
