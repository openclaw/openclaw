import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import {
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
} from "../../tool-search.js";
import { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";
import { createPromptBuildToolPolicy } from "./attempt-prompt-support.js";

registerAgentSessionLoopTestLifecycle();

describe("prompt tool policy with the session registry", () => {
  it.each([
    { mode: "tools", include: [{ source: "mcp" }] },
    { mode: "tools", include: [] },
    false,
  ] satisfies Array<NonNullable<NonNullable<OpenClawConfig["tools"]>["toolSearch"]>>)(
    "does not grant a direct client shadow through its native plugin: %j",
    async (toolSearch) => {
      const config: OpenClawConfig = { tools: { codeMode: false, toolSearch } };
      const catalogRef = createToolSearchCatalogRef();
      const native = ["acme_lookup", "acme_status"].map((name) => {
        const tool = createStubTool(name);
        tool.execute = vi.fn(async () => ({ content: [], details: { owner: "acme" } }));
        setPluginToolMeta(tool, { pluginId: "acme", optional: false });
        return tool;
      });
      try {
        const { tools: effectiveTools } = applyToolSearchCatalog({
          config,
          catalogRef,
          tools: [...(toolSearch ? createToolSearchTools({ config, catalogRef }) : []), ...native],
        });
        const clients = prepareEmbeddedAttemptClientTools({
          attempt: { config, sessionId: "session", runId: "run" },
          catalogToolHookContext: undefined,
          codeModeControlsEnabledForRun: false,
          deferredDirectoryToolsCallable: false,
          effectiveTools,
          replaySafetyOptions: { declaredReplaySafe: () => undefined },
          sessionAgentId: "main",
          toolSearchCatalogRef: catalogRef,
          toolSearchRuntimeConfig: config,
          uncompactedEffectiveTools: native,
          clientTools: [
            {
              type: "function",
              function: {
                name: "acme_lookup",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        });
        const { session } = await createTestSession({ customTools: clients.allCustomTools });
        expect(session.getToolDefinition("acme_lookup")).toBe(clients.clientToolDefs[0]);
        const policy = createPromptBuildToolPolicy({
          session,
          effectiveTools,
          uncompactedEffectiveTools: native,
          tools: native,
          catalogRef,
          codeModeControlsEnabled: false,
        });

        const restricted = policy.apply(["acme"]);
        const unauthorizedWinner = session.agent.state.tools.find(
          (tool) => tool.name === "acme_lookup",
        );
        await unauthorizedWinner?.execute("denied-client", {});
        expect(clients.clientToolCallSlots).toEqual([]);
        expect(session.getActiveToolNames()).toEqual(["acme_status"]);
        expect(restricted.effectiveTools.map((tool) => tool.name)).toEqual(["acme_status"]);
        expect(restricted.uncompactedEffectiveTools.map((tool) => tool.name)).toEqual([
          "acme_status",
        ]);
        const status = expectDefined(session.agent.state.tools[0], "authorized plugin tool");
        await expect(status.execute("plugin-call", {})).resolves.toMatchObject({
          details: { owner: "acme" },
        });

        policy.apply(undefined);
        const client = expectDefined(
          session.agent.state.tools.find((tool) => tool.name === "acme_lookup"),
          "restored client winner",
        );
        await client.execute("restored-client", {});
        expect(clients.clientToolCallSlots).toMatchObject([
          { toolCallId: "restored-client", name: "acme_lookup", completed: true },
        ]);
        policy.apply(["acme_lookup"]);
        expect(session.getActiveToolNames()).toEqual(["acme_lookup"]);

        policy.apply(["acme"]);
        clients.refreshTools();
        session.replaceCustomTools(clients.allCustomTools, clients.sessionToolAllowlist);
        policy.refresh();
        expect(session.getActiveToolNames()).toEqual(["acme_status"]);
        expect(clients.clientToolCallSlots).toHaveLength(1);
        expect(native[0]?.execute).not.toHaveBeenCalled();
      } finally {
        clearToolSearchCatalog({ catalogRef });
      }
    },
  );
});
