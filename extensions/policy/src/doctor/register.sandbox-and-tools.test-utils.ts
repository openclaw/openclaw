// Imported by register.test.ts to keep its mocked suite in one Vitest module graph.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPolicyEvidence } from "../policy-state.js";
import {
  cfgWithPolicy,
  createCustomBindInput,
  createBackendContainerPolicy,
  createSharedSandboxRequirements,
  cfgWithPolicyAgents,
  cfgWithPolicyAgentEntries,
  createToolPosturePolicy,
  policyForAgents,
  createGatewayHttpInput,
  createReleaseAgentPolicyConfig,
  cfgWithPolicyOverrides,
  cfgWithPolicySandbox,
  runPolicyChecksFixture,
  runGlobalPolicyDoctorFixture,
  setupPolicyDoctorTest,
  teardownPolicyDoctorTest,
} from "./register.test-harness.js";

function runLoopbackOnlyPolicyFixture(cfg: Parameters<typeof runGlobalPolicyDoctorFixture>[0]) {
  return runGlobalPolicyDoctorFixture(cfg, {
    gateway: { exposure: { allowNonLoopbackBind: false } },
  });
}

describe("registerPolicyDoctorChecks", () => {
  beforeEach(setupPolicyDoctorTest);

  afterEach(teardownPolicyDoctorTest);

  it("ignores agent-local Docker and browser posture under shared sandbox scope", async () => {
    const cfg = cfgWithPolicyAgents({
      defaults: {
        sandbox: {
          mode: "all",
          backend: "docker",
          scope: "shared",
          docker: {
            network: "none",
            binds: ["/shared:/shared:ro"],
          },
          browser: {
            enabled: true,
            cdpSourceRange: "172.21.0.1/32",
            binds: ["/browser-shared:/browser-shared:ro"],
          },
        },
      },
      entries: {
        runner: {
          sandbox: {
            docker: {
              network: "host",
              binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
            },
            browser: {
              cdpSourceRange: "",
              binds: ["/unsafe-browser:/unsafe-browser:rw"],
            },
          },
        },
      },
    });

    const evidence = collectPolicyEvidence(cfg);
    const runnerEvidence = (evidence.sandboxPosture ?? []).filter(
      (entry) => entry.agentId === "runner",
    );

    expect(runnerEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "containerNetwork",
          value: "none",
          source: "oc://openclaw.config/agents/defaults/sandbox/docker/network",
        }),
        expect.objectContaining({
          kind: "browserCdpSourceRange",
          value: "172.21.0.1/32",
          source: "oc://openclaw.config/agents/defaults/sandbox/browser/cdpSourceRange",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/shared:/shared:ro",
          source: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/browser-shared:/browser-shared:ro",
          source: "oc://openclaw.config/agents/defaults/sandbox/browser/binds/#0",
        }),
      ]),
    );
    expect(runnerEvidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bind: "/var/run/docker.sock:/var/run/docker.sock:rw" }),
        expect.objectContaining({ bind: "/unsafe-browser:/unsafe-browser:rw" }),
        expect.objectContaining({
          kind: "containerNetwork",
          value: "host",
        }),
      ]),
    );
  });

  it("treats blank agent browser CDP source range as an explicit clear", async () => {
    const cfg = cfgWithPolicyAgents({
      defaults: {
        sandbox: {
          mode: "all",
          backend: "docker",
          browser: { enabled: true, cdpSourceRange: "172.21.0.1/32" },
        },
      },
      entries: {
        runner: {
          sandbox: {
            browser: { cdpSourceRange: "" },
          },
        },
      },
    });
    const result = await runPolicyChecksFixture(
      {
        sandbox: {
          browser: { requireCdpSourceRange: true },
        },
      },
      cfg,
    );

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        checkId: "policy/sandbox-browser-cdp-source-range-missing",
        ocPath: "oc://openclaw.config/agents/entries/runner/sandbox/browser/cdpSourceRange",
      }),
    );
  });

  it("reports enabled container posture rules that the backend cannot observe", async () => {
    const cfg = cfgWithPolicySandbox({
      mode: "all",
      backend: "openshell",
      docker: {
        network: "host",
        binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
        seccompProfile: "unconfined",
      },
    });
    const result = await runPolicyChecksFixture(createBackendContainerPolicy(["openshell"]), cfg);
    const evidence = collectPolicyEvidence(cfg);

    expect(evidence.sandboxPosture).toContainEqual(
      expect.objectContaining({
        kind: "backend",
        value: "openshell",
      }),
    );
    expect(evidence.sandboxPosture).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "containerNetwork" }),
        expect.objectContaining({ kind: "containerMount" }),
        expect.objectContaining({ kind: "containerSecurityProfile" }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-container-posture-unobservable",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/backend",
          requirement: "oc://policy.jsonc/sandbox/containers/denyHostNetwork",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-posture-unobservable",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/backend",
          requirement: "oc://policy.jsonc/sandbox/containers/denyContainerRuntimeSocketMounts",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-posture-unobservable",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/backend",
          requirement: "oc://policy.jsonc/sandbox/containers/denyUnconfinedProfiles",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/sandbox-container-host-network-denied" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-runtime-socket-mount" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-unconfined-profile" }),
      ]),
    );
  });

  it("evaluates inherited container mounts for browser containers on non-Docker backends", async () => {
    const cfg = cfgWithPolicySandbox({
      mode: "all",
      backend: "openshell",
      docker: {
        binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
      },
      browser: {
        enabled: true,
        cdpSourceRange: "172.21.0.1/32",
      },
    });
    const result = await runPolicyChecksFixture(
      {
        sandbox: {
          allowBackends: ["openshell"],
          containers: {
            requireReadOnlyMounts: true,
            denyContainerRuntimeSocketMounts: true,
          },
        },
      },
      cfg,
    );
    const evidence = collectPolicyEvidence(cfg);

    expect(evidence.sandboxPosture).toContainEqual(
      expect.objectContaining({
        kind: "containerMount",
        bindSurface: "browser",
        bind: "/var/run/docker.sock:/var/run/docker.sock:rw",
        source: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
      }),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-container-mount-mode-required",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-runtime-socket-mount",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
        }),
      ]),
    );
  });

  it("normalizes mixed-case Docker backend before collecting container posture", async () => {
    const cfg = cfgWithPolicySandbox({
      mode: "all",
      backend: "Docker",
      docker: {
        network: "host",
        binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
        seccompProfile: "unconfined",
      },
    });
    const result = await runPolicyChecksFixture(createBackendContainerPolicy(["docker"]), cfg);
    const evidence = collectPolicyEvidence(cfg);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "backend", value: "docker" }),
        expect.objectContaining({ kind: "containerNetwork", value: "host" }),
        expect.objectContaining({ kind: "containerMount" }),
        expect.objectContaining({
          kind: "containerSecurityProfile",
          profile: "seccomp",
          value: "unconfined",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/sandbox-container-host-network-denied" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-runtime-socket-mount" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-unconfined-profile" }),
      ]),
    );
  });

  it("evaluates Podman container posture without reporting it as unobservable", async () => {
    const cfg = cfgWithPolicySandbox({
      mode: "all",
      backend: "podman",
      docker: {
        network: "host",
        binds: ["/run/podman/podman.sock:/run/podman/podman.sock:rw"],
        seccompProfile: "unconfined",
      },
    });
    const result = await runPolicyChecksFixture(createBackendContainerPolicy(["podman"]), cfg);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/sandbox-container-host-network-denied" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-runtime-socket-mount" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-unconfined-profile" }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-container-posture-unobservable",
        }),
      ]),
    );
  });

  it("uses explicit agent sandbox scope before inherited shared scope", async () => {
    const cfg = cfgWithPolicyAgents({
      defaults: {
        sandbox: {
          mode: "all",
          backend: "docker",
          scope: "shared",
          docker: {
            network: "none",
          },
        },
      },
      entries: {
        runner: {
          sandbox: {
            scope: "agent",
            docker: {
              network: "host",
              binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
            },
            browser: {
              enabled: true,
              cdpSourceRange: "172.21.0.1/32",
              binds: ["/browser:/browser:rw"],
            },
          },
        },
      },
    });

    const evidence = collectPolicyEvidence(cfg);
    const runnerEvidence = (evidence.sandboxPosture ?? []).filter(
      (entry) => entry.agentId === "runner",
    );

    expect(runnerEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "containerNetwork",
          value: "host",
          source: "oc://openclaw.config/agents/entries/runner/sandbox/docker/network",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/var/run/docker.sock:/var/run/docker.sock:rw",
          source: "oc://openclaw.config/agents/entries/runner/sandbox/docker/binds/#0",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/browser:/browser:rw",
          source: "oc://openclaw.config/agents/entries/runner/sandbox/browser/binds/#0",
        }),
      ]),
    );
  });

  it("accepts configured sandbox posture that matches policy", async () => {
    const cfg = cfgWithPolicySandbox({
      mode: "all",
      backend: "docker",
      docker: {
        network: "none",
        binds: ["/data:/data:ro"],
        seccompProfile: "runtime/default",
      },
      browser: { enabled: true, cdpSourceRange: "172.21.0.1/32" },
    });
    const result = await runPolicyChecksFixture(createSharedSandboxRequirements(["docker"]), cfg);

    expect(result.findings).toEqual([]);
  });

  it("applies agent-scoped sandbox claims only to matching agents", async () => {
    const cfg = cfgWithPolicyAgentEntries({
      sebby: { sandbox: { mode: "off", backend: "ssh" } },
      buddy: { sandbox: { mode: "all", backend: "docker" } },
    });
    const result = await runPolicyChecksFixture(
      {
        sandbox: {
          requireMode: ["all"],
        },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            sandbox: {
              allowBackends: ["docker"],
            },
          },
        },
      },
      cfg,
    );

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-mode-unapproved",
          ocPath: "oc://openclaw.config/agents/entries/sebby/sandbox/mode",
          requirement: "oc://policy.jsonc/sandbox/requireMode",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-backend-unapproved",
          ocPath: "oc://openclaw.config/agents/entries/sebby/sandbox/backend",
          requirement: "oc://policy.jsonc/scopes/sebby/sandbox/allowBackends",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/entries/buddy/sandbox/backend",
          requirement: "oc://policy.jsonc/scopes/sebby/sandbox/allowBackends",
        }),
      ]),
    );
  });

  it("does not apply sandbox overlays from invalid scoped policy", async () => {
    const cfg = cfgWithPolicyAgentEntries({ sebby: { sandbox: { mode: "off" } } });
    const result = await runPolicyChecksFixture(
      policyForAgents("sebby", ["sebby"], {
        channels: { allow: ["discord"] },
        sandbox: {
          requireMode: ["all"],
        },
      }),
      cfg,
    );

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        target: "oc://policy.jsonc/scopes/sebby/channels",
      }),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-mode-unapproved",
          requirement: "oc://policy.jsonc/scopes/sebby/sandbox/requireMode",
        }),
      ]),
    );
  });

  it("reports scoped container posture rules that a non-Docker agent group cannot observe", async () => {
    const cfg = createReleaseAgentPolicyConfig();
    const result = await runPolicyChecksFixture(
      policyForAgents("release", ["release-agent"], {
        sandbox: {
          containers: { requireReadOnlyMounts: true },
        },
      }),
      cfg,
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/sandbox-container-posture-unobservable",
        ocPath: "oc://openclaw.config/agents/entries/release-agent/sandbox/backend",
        requirement: "oc://policy.jsonc/scopes/release/sandbox/containers/requireReadOnlyMounts",
      }),
    ]);
  });

  it("allows scoped non-Docker agent groups when container posture rules are off", async () => {
    const cfg = createReleaseAgentPolicyConfig();
    const result = await runPolicyChecksFixture(
      policyForAgents("release", ["release-agent"], {
        sandbox: {
          containers: { requireReadOnlyMounts: false },
        },
      }),
      cfg,
    );

    expect(result.findings).toEqual([]);
  });

  it("does not fall back to default browser posture for scoped browser-disabled agents", async () => {
    const cfg = cfgWithPolicyAgents({
      defaults: {
        sandbox: {
          mode: "all",
          backend: "docker",
          browser: { enabled: true, network: "host" },
        },
      },
      entries: {
        "release-agent": {
          sandbox: { browser: { enabled: false } },
        },
      },
    });
    const result = await runPolicyChecksFixture(
      policyForAgents("release", ["release-agent"], {
        sandbox: {
          containers: { denyHostNetwork: true },
          browser: { requireCdpSourceRange: true },
        },
      }),
      cfg,
    );
    const evidence = collectPolicyEvidence(cfg);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "release-agent",
          kind: "browserCdpSourceRange",
          value: false,
        }),
        expect.objectContaining({
          kind: "containerNetwork",
          networkSurface: "browser",
          value: "host",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("applies main-scoped sandbox claims to defaults when unrelated agents exist", async () => {
    const cfg = cfgWithPolicyAgents({
      defaults: {
        sandbox: { mode: "off" },
      },
      entries: {
        worker: {
          sandbox: { mode: "all" },
        },
      },
    });
    const result = await runPolicyChecksFixture(
      policyForAgents("mainSandbox", ["main"], { sandbox: { requireMode: ["all"] } }),
      cfg,
    );

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        checkId: "policy/sandbox-mode-unapproved",
        ocPath: "oc://openclaw.config/agents/defaults/sandbox/mode",
        requirement: "oc://policy.jsonc/scopes/mainSandbox/sandbox/requireMode",
      }),
    );
  });

  it("reports tool posture denied by policy", async () => {
    const cfg = cfgWithPolicyOverrides({
      tools: {
        profile: "coding",
        deny: ["write"],
        exec: { security: "full", ask: "off", host: "gateway" },
        fs: { workspaceOnly: false },
        elevated: { enabled: true, allowFrom: { whatsapp: ["+15550000001", 15550000002] } },
      },
      agents: {
        entries: {
          reviewer: {
            tools: {
              profile: "messaging",
              deny: ["group:runtime", "group:fs"],
              exec: { security: "deny", ask: "always", host: "sandbox" },
              fs: { workspaceOnly: true },
              elevated: { enabled: false },
            },
          },
        },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(
      cfg,
      createToolPosturePolicy(["deny", "allowlist"]),
    );
    const evidence = collectPolicyEvidence(cfg);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-profile",
          kind: "profile",
          value: "coding",
          source: "oc://openclaw.config/tools/profile",
        }),
        expect.objectContaining({
          id: "reviewer-exec-security",
          kind: "execSecurity",
          value: "deny",
          source: "oc://openclaw.config/agents/entries/reviewer/tools/exec/security",
        }),
        expect.objectContaining({
          id: "tools-elevated-allow-from-whatsapp",
          kind: "elevatedAllowFrom",
          entries: ["+15550000001", "15550000002"],
          source: "oc://openclaw.config/tools/elevated/allowFrom/whatsapp",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-profile-unapproved",
          severity: "error",
          ocPath: "oc://openclaw.config/tools/profile",
          requirement: "oc://policy.jsonc/tools/profiles/allow",
        }),
        expect.objectContaining({
          checkId: "policy/tools-fs-workspace-only-required",
          ocPath: "oc://openclaw.config/tools/fs/workspaceOnly",
          requirement: "oc://policy.jsonc/tools/fs/requireWorkspaceOnly",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-security-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/security",
          requirement: "oc://policy.jsonc/tools/exec/allowSecurity",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-ask-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/ask",
          requirement: "oc://policy.jsonc/tools/exec/requireAsk",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/host",
          requirement: "oc://policy.jsonc/tools/exec/allowHosts",
        }),
        expect.objectContaining({
          checkId: "policy/tools-elevated-enabled",
          ocPath: "oc://openclaw.config/tools/elevated/enabled",
          requirement: "oc://policy.jsonc/tools/elevated/allow",
        }),
        expect.objectContaining({
          checkId: "policy/tools-required-deny-missing",
          ocPath: "oc://openclaw.config/tools/deny",
          requirement: "oc://policy.jsonc/tools/denyTools",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-required-deny-missing",
          ocPath: "oc://openclaw.config/agents/entries/reviewer/tools/deny",
        }),
      ]),
    );
  });

  it("accepts configured tool posture that matches policy", async () => {
    const cfg = cfgWithPolicyOverrides({
      tools: {
        profile: "messaging",
        deny: ["group:runtime", "group:fs"],
        exec: { security: "deny", ask: "always", host: "sandbox" },
        fs: { workspaceOnly: true },
        elevated: { enabled: false },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, createToolPosturePolicy(["deny"]));

    expect(result.findings).toEqual([]);
  });

  it("accepts agent exec mode posture that matches policy", async () => {
    const cfg = cfgWithPolicyAgentEntries({ reviewer: { tools: { exec: { mode: "ask" } } } });
    const result = await runGlobalPolicyDoctorFixture(
      cfg,
      policyForAgents("reviewer", ["reviewer"], {
        tools: {
          exec: {
            allowSecurity: ["allowlist"],
            requireAsk: ["on-miss"],
          },
        },
      }),
    );

    expect(result.findings).toEqual([]);
  });

  it("reports global and agent-scoped tool claims independently", async () => {
    const cfg = cfgWithPolicyOverrides({
      tools: {
        exec: { host: "sandbox" },
      },
      agents: {
        entries: {
          sebby: { tools: { exec: { host: "node" } } },
          buddy: { tools: { exec: { host: "sandbox" } } },
        },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        exec: { allowHosts: ["sandbox", "gateway"] },
      },
      scopes: {
        sebby: {
          agentIds: ["sebby"],
          tools: {
            exec: { allowHosts: ["gateway"] },
          },
        },
      },
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/agents/entries/sebby/tools/exec/host",
          requirement: "oc://policy.jsonc/tools/exec/allowHosts",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/agents/entries/sebby/tools/exec/host",
          requirement: "oc://policy.jsonc/scopes/sebby/tools/exec/allowHosts",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/entries/buddy/tools/exec/host",
        }),
      ]),
    );
  });

  it("does not apply agent-scoped tool claims to other agents", async () => {
    const cfg = cfgWithPolicyAgentEntries({
      sebby: { tools: { exec: { host: "sandbox" } } },
      buddy: { tools: { exec: { host: "node" } } },
    });
    const result = await runGlobalPolicyDoctorFixture(
      cfg,
      policyForAgents("sebby", ["sebby"], {
        tools: {
          exec: { allowHosts: ["sandbox"] },
        },
      }),
    );

    expect(result.findings).toEqual([]);
  });

  it("reports global and agent-scoped alsoAllow drift", async () => {
    const cfg = cfgWithPolicyOverrides({
      tools: { alsoAllow: ["read", "cron"] },
      agents: {
        entries: {
          sebby: { tools: { alsoAllow: ["read", "gateway"] } },
          buddy: { tools: { alsoAllow: ["read"] } },
        },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        alsoAllow: { expected: ["read", "message"] },
      },
      scopes: {
        sebby: {
          agentIds: ["sebby"],
          tools: {
            alsoAllow: { expected: ["read", "message"] },
          },
        },
      },
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-also-allow-missing",
          ocPath: "oc://openclaw.config/tools/alsoAllow",
          requirement: "oc://policy.jsonc/tools/alsoAllow/expected",
        }),
        expect.objectContaining({
          checkId: "policy/tools-also-allow-unexpected",
          ocPath: "oc://openclaw.config/tools/alsoAllow",
          requirement: "oc://policy.jsonc/tools/alsoAllow/expected",
        }),
        expect.objectContaining({
          checkId: "policy/tools-also-allow-missing",
          ocPath: "oc://openclaw.config/agents/entries/sebby/tools/alsoAllow",
          requirement: "oc://policy.jsonc/scopes/sebby/tools/alsoAllow/expected",
        }),
        expect.objectContaining({
          checkId: "policy/tools-also-allow-unexpected",
          ocPath: "oc://openclaw.config/agents/entries/sebby/tools/alsoAllow",
          requirement: "oc://policy.jsonc/scopes/sebby/tools/alsoAllow/expected",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: "oc://policy.jsonc/scopes/sebby/tools/alsoAllow/expected",
          ocPath: "oc://openclaw.config/agents/entries/buddy/tools/alsoAllow",
        }),
      ]),
    );
  });

  it("reports unexpected alsoAllow entries when policy expects none", async () => {
    const cfg = cfgWithPolicyOverrides({
      tools: { alsoAllow: ["read"] },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        alsoAllow: { expected: [] },
      },
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-also-allow-unexpected",
        ocPath: "oc://openclaw.config/tools/alsoAllow",
        requirement: "oc://policy.jsonc/tools/alsoAllow/expected",
      }),
    ]);
  });

  it("uses config-level exec defaults and normalizes required deny aliases", async () => {
    const cfg = cfgWithPolicyOverrides({
      tools: {
        deny: ["exec", "apply_patch"],
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        exec: {
          allowSecurity: ["deny"],
          requireAsk: ["always"],
          allowHosts: ["auto"],
        },
        denyTools: ["bash", "apply-patch"],
      },
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-exec-security-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/security",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-ask-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/ask",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-required-deny-missing",
        }),
      ]),
    );
  });

  it("accepts omitted exec defaults and individual denies for required deny groups", async () => {
    const cfg = cfgWithPolicyOverrides({
      tools: {
        deny: [
          "exec",
          "process",
          "code_execution",
          "secrets",
          "ls",
          "read",
          "write",
          "edit",
          "apply_patch",
        ],
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        exec: {
          allowSecurity: ["full"],
          requireAsk: ["off"],
          allowHosts: ["auto"],
        },
        denyTools: ["group:runtime", "group:fs"],
      },
    });

    expect(result.findings).toEqual([]);
  });

  it("accepts wildcard tool denies for required tool posture", async () => {
    const cfg = cfgWithPolicyOverrides({
      tools: {
        deny: ["web_*"],
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        denyTools: ["web_search"],
      },
    });

    expect(result.findings).toEqual([]);
  });

  it("accepts canonical tool groups for required tool denies", async () => {
    const cfg = cfgWithPolicyOverrides({
      tools: {
        deny: ["group:openclaw"],
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        denyTools: ["message"],
      },
    });
    const evidence = collectPolicyEvidence(cfg);

    expect(evidence.toolPosture).toContainEqual(
      expect.objectContaining({
        id: "tools-deny",
        kind: "deny",
        entries: ["group:openclaw"],
        source: "oc://openclaw.config/tools/deny",
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it("treats globally disabled elevated mode as disabling per-agent elevated posture", async () => {
    const cfg = cfgWithPolicyOverrides({
      tools: {
        elevated: { enabled: false },
      },
      agents: {
        entries: {
          reviewer: {
            tools: {
              elevated: { enabled: true },
            },
          },
        },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        elevated: { allow: false },
      },
    });
    const evidence = collectPolicyEvidence(cfg);

    expect(evidence.toolPosture).toContainEqual(
      expect.objectContaining({
        id: "reviewer-elevated-enabled",
        kind: "elevatedEnabled",
        value: false,
        source: "oc://openclaw.config/tools/elevated/enabled",
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it("treats omitted tool profile as full posture for profile allow policy", async () => {
    const cfg = cfgWithPolicy();
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        profiles: { allow: ["messaging"] },
      },
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-profile-unapproved",
        ocPath: "oc://openclaw.config/tools/profile",
        requirement: "oc://policy.jsonc/tools/profiles/allow",
      }),
    ]);
  });

  it("uses deny as the omitted exec security default for explicit sandbox host", async () => {
    const cfg = cfgWithPolicyOverrides({
      tools: {
        exec: { host: "sandbox" },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        exec: {
          allowSecurity: ["deny"],
          allowHosts: ["sandbox"],
        },
      },
    });
    const evidence = collectPolicyEvidence(cfg);

    expect(evidence.toolPosture).toContainEqual(
      expect.objectContaining({
        id: "tools-exec-security",
        kind: "execSecurity",
        value: "deny",
        source: "oc://openclaw.config/tools/exec/security",
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it("uses deny as the omitted exec security default for auto host when sandbox can apply", async () => {
    const cfg = cfgWithPolicySandbox({ mode: "all" });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        exec: {
          allowSecurity: ["deny"],
          allowHosts: ["auto"],
        },
      },
    });
    const evidence = collectPolicyEvidence(cfg);

    expect(evidence.toolPosture).toContainEqual(
      expect.objectContaining({
        id: "tools-exec-security",
        kind: "execSecurity",
        value: "deny",
        source: "oc://openclaw.config/tools/exec/security",
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it("keeps omitted auto-host exec security full when sandbox is non-main only", async () => {
    const cfg = cfgWithPolicySandbox({ mode: "non-main" });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      tools: {
        exec: {
          allowSecurity: ["deny"],
          allowHosts: ["auto"],
        },
      },
    });
    const evidence = collectPolicyEvidence(cfg);

    expect(evidence.toolPosture).toContainEqual(
      expect.objectContaining({
        id: "tools-exec-security",
        kind: "execSecurity",
        value: "full",
        source: "oc://openclaw.config/tools/exec/security",
      }),
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-exec-security-unapproved",
        ocPath: "oc://openclaw.config/tools/exec/security",
        requirement: "oc://policy.jsonc/tools/exec/allowSecurity",
      }),
    ]);
  });

  it("reports gateway exposure settings denied by policy", async () => {
    const cfg = cfgWithPolicyOverrides({
      gateway: {
        bind: "lan",
        auth: { mode: "none" },
        controlUi: {
          dangerouslyAllowHostHeaderOriginFallback: true,
        },
        tailscale: { mode: "funnel" },
        mode: "remote",
        http: createGatewayHttpInput(),
        nodes: {
          commands: { allow: ["mcp.help", "mcp.invoke", "system.run"] },
        },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      gateway: {
        exposure: {
          allowNonLoopbackBind: false,
          allowTailscaleFunnel: false,
        },
        auth: {
          requireAuth: true,
          requireExplicitRateLimit: true,
        },
        controlUi: {
          allowInsecure: false,
        },
        remote: {
          allow: false,
        },
        http: {
          denyEndpoints: ["chatCompletions", "responses"],
          requireUrlAllowlists: true,
        },
        nodes: {
          denyCommands: ["system.run"],
        },
      },
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/gateway-non-loopback-bind",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/bind",
          requirement: "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-auth-disabled",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/auth/mode",
          requirement: "oc://policy.jsonc/gateway/auth/requireAuth",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-rate-limit-missing",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/auth/rateLimit",
          requirement: "oc://policy.jsonc/gateway/auth/requireExplicitRateLimit",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-tailscale-funnel",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/tailscale/mode",
          requirement: "oc://policy.jsonc/gateway/exposure/allowTailscaleFunnel",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-remote-enabled",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/mode",
          requirement: "oc://policy.jsonc/gateway/remote/allow",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-endpoint-enabled",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/chatCompletions/enabled",
          requirement: "oc://policy.jsonc/gateway/http/denyEndpoints",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/chatCompletions/images/allowUrl",
          requirement: "oc://policy.jsonc/gateway/http/requireUrlAllowlists",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-node-command-denied",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/nodes/commands/deny",
          requirement: "oc://policy.jsonc/gateway/nodes/denyCommands",
        }),
      ]),
    );
    expect(result.findings).toHaveLength(11);
  });

  it("does not report gateway node commands denied by runtime config", async () => {
    const cfg = cfgWithPolicyOverrides({
      gateway: {
        nodes: {
          commands: {
            allow: ["system.run"],
            deny: ["system.run"],
          },
        },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      gateway: {
        nodes: {
          denyCommands: ["system.run"],
        },
      },
    });

    expect(result.findings).toEqual([]);
  });

  it("reports gateway node commands denied by policy without explicit extra allows", async () => {
    const cfg = cfgWithPolicyOverrides({
      gateway: {
        nodes: {},
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      gateway: {
        nodes: {
          denyCommands: ["system.run"],
        },
      },
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-node-command-denied",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/nodes/commands/deny",
        requirement: "oc://policy.jsonc/gateway/nodes/denyCommands",
      }),
    ]);
  });

  it("reports omitted gateway bind when non-loopback exposure is denied", async () => {
    const cfg = cfgWithPolicyOverrides({
      gateway: {},
    });
    const result = await runLoopbackOnlyPolicyFixture(cfg);

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-non-loopback-bind",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/bind",
        requirement: "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind",
      }),
    ]);
  });

  it("does not report omitted gateway bind when Tailscale forces loopback", async () => {
    const cfg = cfgWithPolicyOverrides({
      gateway: {
        tailscale: { mode: "serve" },
      },
    });
    const result = await runLoopbackOnlyPolicyFixture(cfg);

    expect(result.findings).toEqual([]);
  });

  it("reports preserved Tailscale Funnel routes when policy denies Funnel exposure", async () => {
    const cfg = cfgWithPolicyOverrides({
      gateway: {
        tailscale: { mode: "serve", preserveFunnel: true },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      gateway: {
        exposure: {
          allowTailscaleFunnel: false,
        },
      },
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-tailscale-funnel",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/tailscale/preserveFunnel",
        requirement: "oc://policy.jsonc/gateway/exposure/allowTailscaleFunnel",
      }),
    ]);
  });

  it("reports missing gateway rate limits when gateway config is omitted", async () => {
    const result = await runGlobalPolicyDoctorFixture(cfgWithPolicy(), {
      gateway: {
        auth: {
          requireExplicitRateLimit: true,
        },
      },
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-rate-limit-missing",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/auth/rateLimit",
        requirement: "oc://policy.jsonc/gateway/auth/requireExplicitRateLimit",
      }),
    ]);
  });

  it("does not report inactive custom bind hosts", async () => {
    const cfg = cfgWithPolicyOverrides(createCustomBindInput("loopback", "0.0.0.0"));
    const result = await runLoopbackOnlyPolicyFixture(cfg);

    expect(result.findings).toEqual([]);
  });

  it("does not report loopback custom bind hosts", async () => {
    const cfg = cfgWithPolicyOverrides(createCustomBindInput("custom", "127.0.0.1"));
    const result = await runLoopbackOnlyPolicyFixture(cfg);

    expect(result.findings).toEqual([]);
  });

  it("reports valid non-loopback custom bind hosts", async () => {
    const cfg = cfgWithPolicyOverrides(createCustomBindInput("custom", "192.168.1.20"));
    const result = await runLoopbackOnlyPolicyFixture(cfg);

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-non-loopback-bind",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/customBindHost",
        requirement: "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind",
      }),
    ]);
  });

  it("does not report blank custom bind config as active non-loopback exposure", async () => {
    const cfg = cfgWithPolicyOverrides(createCustomBindInput("custom", "   "));
    const result = await runLoopbackOnlyPolicyFixture(cfg);

    expect(result.findings).toEqual([]);
  });

  it.each(["localhost", "::1", "192.168.001.20"])(
    "does not report invalid custom bind host %s as active non-loopback exposure",
    async (customBindHost) => {
      const cfg = cfgWithPolicyOverrides(createCustomBindInput("custom", customBindHost));
      const result = await runLoopbackOnlyPolicyFixture(cfg);

      expect(result.findings).toEqual([]);
    },
  );

  it("reports configured gateway remote URLs when remote mode is active", async () => {
    const cfg = cfgWithPolicyOverrides({
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://remote.example.test:18789",
        },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      gateway: {
        remote: {
          allow: false,
        },
      },
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-remote-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/mode",
        requirement: "oc://policy.jsonc/gateway/remote/allow",
      }),
      expect.objectContaining({
        checkId: "policy/gateway-remote-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/remote/url",
        requirement: "oc://policy.jsonc/gateway/remote/allow",
      }),
    ]);
  });

  it("does not report inert remote config outside remote mode", async () => {
    const cfg = cfgWithPolicyOverrides({
      gateway: {
        remote: {
          url: "wss://remote.example.test:18789",
        },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      gateway: {
        remote: {
          allow: false,
        },
      },
    });

    expect(result.findings).toEqual([]);
  });

  it("reports default Responses URL fetching without allowlists", async () => {
    const cfg = cfgWithPolicyOverrides({
      gateway: {
        http: {
          endpoints: {
            responses: {
              enabled: true,
            },
          },
        },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      gateway: {
        http: {
          requireUrlAllowlists: true,
        },
      },
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/files/allowUrl",
          requirement: "oc://policy.jsonc/gateway/http/requireUrlAllowlists",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/images/allowUrl",
          requirement: "oc://policy.jsonc/gateway/http/requireUrlAllowlists",
        }),
      ]),
    );
    expect(result.findings).toHaveLength(2);
  });

  it("reports wildcard Responses URL allowlists as unrestricted", async () => {
    const cfg = cfgWithPolicyOverrides({
      gateway: {
        http: {
          endpoints: {
            responses: {
              enabled: true,
              files: { urlAllowlist: ["*"] },
              images: { urlAllowlist: ["*."] },
            },
          },
        },
      },
    });
    const result = await runGlobalPolicyDoctorFixture(cfg, {
      gateway: {
        http: {
          requireUrlAllowlists: true,
        },
      },
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/files/allowUrl",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/images/allowUrl",
        }),
      ]),
    );
    expect(result.findings).toHaveLength(2);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
