import path from "node:path";
import { afterAll, expect, it, onTestFinished } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-selection.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { resolveGatewayOwnerOnlyToolDenylist } from "../security/dangerous-tools.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { createOpenClawCodingToolsInternal } from "./agent-tools.js";
import { applyCodeModeCatalog, buildCodeModeCatalogPrompt } from "./code-mode.js";
import { prepareConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search-catalog.js";
import type { AnyAgentTool } from "./tools/common.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-wake-resolution-");

it.each([false, true])(
  "keeps the requester's plugin catalog on completion (subagent=%s)",
  async (subagent) => {
    const store = path.join(sessionDirs.make(), "sessions.json");
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      plugins: { enabled: true, entries: { "wake-probe": { enabled: true } } },
      tools: { codeMode: false, toolSearch: false },
      session: { store },
    };
    const artifact = {
      source: "/synthetic/wake-probe/index.js",
      rootDir: "/synthetic/wake-probe",
      origin: "bundled" as const,
      preferBuiltPluginArtifacts: false,
    };
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "wake-probe",
      ...artifact,
      contracts: { tools: ["memory_search", "memory_get", "intent"] },
    });
    bindPluginRuntimeArtifactSelection(record, {
      preferBuiltPluginArtifacts: false,
      runtimeEntry: resolvePluginRuntimeArtifactSelection({ ...artifact, entryKind: "runtime" }),
    });
    builder.registry.plugins.push(record);
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: record.id, ...artifact, enabledByDefault: true, contracts: record.contracts },
      ],
    });
    setPluginRuntimeLoadContext(builder.registry, {
      rawConfig: config,
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: artifact.rootDir,
      env: process.env,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      manifestRegistry: snapshot.manifestRegistry,
      metadataSnapshot: snapshot,
    });
    const api = builder.createApi(record, { config, registrationMode: "full" });
    const tool = (name: string): AnyAgentTool => ({
      name,
      label: name,
      description: name,
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [], details: {} };
      },
    });
    api.registerTool(() => tool("memory_search"), {
      name: "memory_search",
      workspaceAccess: "execute",
    });
    api.registerTool(() => tool("memory_get"), { name: "memory_get", workspaceAccess: "execute" });
    let intentExecutions = 0;
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => {
          return {
            ...tool("intent"),
            async execute() {
              context.assertInvocationCurrent();
              intentExecutions += 1;
              return { content: [], details: {} };
            },
          };
        },
      },
      { name: "intent", workspaceAccess: "execute" },
    );
    const options = {
      config,
      workspaceDir: artifact.rootDir,
      agentSessionKey: subagent
        ? "agent:main:subagent:requester"
        : "agent:main:dashboard:chat-wake-probe",
      sessionId: "wake-probe-session",
      agentChannel: "webchat",
    };
    try {
      const resolve = (operator: boolean) =>
        withPluginRuntimeRegistryScope(builder.registry, () =>
          resolveOpenClawPluginToolsForOptions({
            options: {
              ...options,
              runId: operator ? "operator-run" : "wake-run",
              senderIsOwner: operator ? true : undefined,
              requesterSenderId: operator ? "operator" : undefined,
              clientCaps: operator ? ["ui-commands", "inline-widgets"] : undefined,
              assertInvocationCurrent: operator ? () => {} : undefined,
              inputProvenance: operator
                ? undefined
                : {
                    kind: "inter_session",
                    sourceChannel: "internal",
                    sourceTool: "subagent_announce",
                  },
            },
          }),
        );
      const operator = resolve(true);
      const wake = resolve(false);
      expect(operator.map((entry) => entry.name)).toEqual([
        "memory_search",
        "memory_get",
        "intent",
      ]);
      expect(wake.map((entry) => entry.name)).toEqual(["memory_search", "memory_get", "intent"]);
      await expect(wake[2]!.execute("wake-intent", {})).rejects.toThrow("outside an admitted run");

      if (subagent) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: options.agentSessionKey, storePath: store },
          {
            sessionId: options.sessionId,
            updatedAt: 1,
            spawnedBy: "agent:main:main",
            spawnDepth: 1,
            subagentRole: "orchestrator",
            subagentControlScope: "children",
            inheritedToolPolicyVersion: 1,
            inheritedToolDeny: ["intent"],
          },
        );
      }

      const childSessionKey = "agent:main:subagent:wake-probe-child";
      await replaceSessionEntry(
        { agentId: "main", sessionKey: childSessionKey, storePath: store },
        {
          sessionId: "wake-probe-child",
          updatedAt: 1,
          spawnedBy: options.agentSessionKey,
          spawnDepth: subagent ? 2 : 1,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: [],
          inheritedToolDeny: resolveGatewayOwnerOnlyToolDenylist(),
        },
      );
      const inputProvenance = {
        kind: "inter_session" as const,
        sourceSessionKey: childSessionKey,
        sourceTool: "subagent_announce",
      };
      const profile = await prepareConversationCapabilityProfile({
        config,
        sessionKey: options.agentSessionKey,
        sessionId: options.sessionId,
        messageProvider: "webchat",
        modelProvider: "openai",
        modelId: "gpt-5.4",
        inputProvenance,
        trustedInternalHandoff: {
          kind: "subagent-completion",
          sourceSessionKey: childSessionKey,
          sourceSessionId: "wake-probe-child",
          targetSessionKey: options.agentSessionKey,
          targetSessionId: options.sessionId,
          provider: "openai",
          model: "gpt-5.4",
        },
      });
      expect(profile.policy.requesterPolicySource).toBe("completion-handoff");
      const operatorProfile = await prepareConversationCapabilityProfile({
        config,
        sessionKey: options.agentSessionKey,
        sessionId: options.sessionId,
        messageProvider: "webchat",
        senderIsOwner: true,
        senderId: "operator",
      });
      const assemble = (conversationCapabilityProfile: typeof profile, completion: boolean) =>
        withPluginRuntimeRegistryScope(builder.registry, () =>
          createOpenClawCodingToolsInternal({
            config,
            workspaceDir: options.workspaceDir,
            agentId: "main",
            sessionKey: options.agentSessionKey,
            sessionId: options.sessionId,
            runId: completion ? "completion-run" : "operator-run",
            messageProvider: "webchat",
            senderIsOwner: !completion,
            includeCoreTools: false,
            assertInvocationCurrent: () => {},
            conversationCapabilityProfile,
            ...(completion ? { inputProvenance } : { senderId: "operator" }),
          }),
        );
      const listed = assemble(operatorProfile, false);
      const completion = assemble(profile, true);
      const names = ["memory_search", "memory_get", ...(subagent ? [] : ["intent"])];
      expect(listed.map((entry) => entry.name)).toEqual(names);
      expect(completion.map((entry) => entry.name)).toEqual(names);
      const catalog = (tools: AnyAgentTool[]) => {
        const catalogRef = createToolSearchCatalogRef();
        const ctx = { config, catalogRef };
        onTestFinished(() => clearToolSearchCatalog(ctx));
        applyCodeModeCatalog({ ...ctx, tools });
        return {
          definitions: tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
          prompt: buildCodeModeCatalogPrompt(ctx, catalogRef.current?.entries ?? []),
        };
      };
      expect(catalog(completion)).toEqual(catalog(listed));
      if (!subagent) {
        await listed.find((entry) => entry.name === "intent")!.execute("operator-intent", {});
        const refused = await completion
          .find((entry) => entry.name === "intent")!
          .execute("completion-intent", {});
        expect(refused.details).toMatchObject({ gated: true });
        expect(JSON.stringify(refused.content)).toContain(
          "intent is not available during a child-completion turn",
        );
        expect(intentExecutions).toBe(1);
      }
    } finally {
      await disposePluginRegistryInstances(builder.registry);
    }
  },
);
