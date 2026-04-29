import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Command } from "commander";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { aguiChannelPlugin } from "./src/channel.js";
import {
  createAguiHttpHandler,
  createOperatorAguiHttpHandler,
} from "./src/http-handler.js";
import { clawgUiToolFactory } from "./src/client-tools.js";
import {
  getWriter,
  getMessageId,
  pushToolCallId,
  popToolCallId,
  isClientTool,
  setClientToolCalled,
} from "./src/tool-store.js";
import {
  extractToolResultText,
  tryParseA2UIOperations,
  groupBySurface,
  A2UI_OPERATIONS_KEY,
} from "./src/a2ui.js";

// ---------------------------------------------------------------------------
// Hook handlers — exported for testability
// ---------------------------------------------------------------------------

export interface BeforeToolCallEvent {
  toolName: string;
  params?: Record<string, unknown>;
}

export interface ToolCallContext {
  sessionKey?: string;
}

/**
 * Handles the `before_tool_call` OpenClaw hook.
 * Emits TOOL_CALL_START + TOOL_CALL_ARGS (and TOOL_CALL_END for client tools).
 */
export function handleBeforeToolCall(
  event: BeforeToolCallEvent,
  ctx: ToolCallContext,
): void {
  const sk = ctx.sessionKey;
  console.log(
    `[clawg-ui] before_tool_call: tool=${event.toolName}, sessionKey=${sk ?? "none"}, hasParams=${!!(event.params && Object.keys(event.params).length > 0)}, params=${JSON.stringify(event.params ?? {})}`,
  );
  if (!sk) {
    console.log(`[clawg-ui] before_tool_call: skipping, no sessionKey`);
    return;
  }
  const writer = getWriter(sk);
  if (!writer) {
    console.log(
      `[clawg-ui] before_tool_call: skipping, no writer for sessionKey=${sk}`,
    );
    return;
  }
  const toolCallId = `tool-${randomUUID()}`;
  console.log(
    `[clawg-ui] before_tool_call: emitting TOOL_CALL_START, toolCallId=${toolCallId}`,
  );
  writer({
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: event.toolName,
  });
  if (event.params && Object.keys(event.params).length > 0) {
    console.log(
      `[clawg-ui] before_tool_call: emitting TOOL_CALL_ARGS, params=${JSON.stringify(event.params)}`,
    );
    writer({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify(event.params),
    });
  }

  if (isClientTool(sk, event.toolName)) {
    // Client tool: emit TOOL_CALL_END now. The run will finish and the
    // client initiates a new run with the tool result.
    console.log(
      `[clawg-ui] before_tool_call: client tool detected, emitting TOOL_CALL_END immediately`,
    );
    writer({
      type: EventType.TOOL_CALL_END,
      toolCallId,
    });
    setClientToolCalled(sk);
  } else {
    // Server tool: push ID so tool_result_persist can emit
    // TOOL_CALL_RESULT + TOOL_CALL_END after execute() completes.
    console.log(
      `[clawg-ui] before_tool_call: server tool, pushing toolCallId to stack`,
    );
    pushToolCallId(sk, toolCallId);
  }
}

/**
 * Handles the `tool_result_persist` OpenClaw hook.
 * Emits TOOL_CALL_RESULT + TOOL_CALL_END for server-side tools.
 */
export function handleToolResultPersist(
  event: Record<string, unknown>,
  ctx: ToolCallContext,
): void {
  const sk = ctx.sessionKey;
  console.log(
    `[clawg-ui] tool_result_persist: sessionKey=${sk ?? "none"}, event=${JSON.stringify(event)}`,
  );
  if (!sk) {
    console.log(
      `[clawg-ui] tool_result_persist: skipping, no sessionKey`,
    );
    return;
  }
  const writer = getWriter(sk);
  const toolCallId = popToolCallId(sk);
  const messageId = getMessageId(sk);
  console.log(
    `[clawg-ui] tool_result_persist: writer=${writer ? "present" : "missing"}, toolCallId=${toolCallId ?? "none"}, messageId=${messageId ?? "none"}`,
  );
  if (writer && toolCallId && messageId) {
    // Extract actual tool result text from event.message.content
    const msg = (event as Record<string, unknown>).message as
      | { content?: unknown }
      | undefined;
    const resultText = msg?.content
      ? extractToolResultText(msg.content)
      : "";

    console.log(
      `[clawg-ui] tool_result_persist: emitting TOOL_CALL_RESULT and TOOL_CALL_END`,
    );
    // Use a dedicated messageId for the tool result so it doesn't collide
    // with the text message messageId. Tool events are linked via toolCallId.
    const toolResultMessageId = `msg-tool-${toolCallId}`;
    writer({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: toolResultMessageId,
      content: resultText,
    });

    // Detect A2UI and emit ACTIVITY_SNAPSHOT per surface
    const a2uiOps = tryParseA2UIOperations(resultText);
    if (a2uiOps) {
      const groups = groupBySurface(a2uiOps);
      for (const [surfaceId, ops] of groups) {
        writer({
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: `a2ui-surface-${surfaceId}-${toolCallId}`,
          activityType: "a2ui-surface",
          content: { [A2UI_OPERATIONS_KEY]: ops },
          replace: true,
        });
      }
    }

    writer({
      type: EventType.TOOL_CALL_END,
      toolCallId,
    });
  }
}

const plugin: {
  id: string;
  name: string;
  description: string;
  configSchema: ReturnType<typeof emptyPluginConfigSchema>;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: "clawg-ui",
  name: "CLAWG-UI",
  description: "AG-UI protocol endpoint for CopilotKit and HttpAgent clients",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: aguiChannelPlugin });
    api.registerTool(clawgUiToolFactory);
    // Example tools (not published to npm — live in examples/)
    import("./examples/cron-report-tool.js")
      .then(({ cronReportToolFactory }) => {
        api.registerTool(cronReportToolFactory, { name: "cron_report", optional: true });
      })
      .catch(() => {
        // examples/ not available (npm install) — skip
      });

    // Use registerPluginHttpRoute from plugin-runtime which writes directly to
    // the pinned HTTP route registry. api.registerHttpRoute writes to the
    // loader's private registry which is not the one the HTTP handler reads.
    import("openclaw/plugin-sdk/plugin-runtime")
      .then((mod: any) => {
        mod.registerPluginHttpRoute({
          path: "/v1/clawg-ui",
          auth: "plugin",
          match: "exact",
          pluginId: "clawg-ui",
          handler: createAguiHttpHandler(api),
        });
        // Operator-auth AG-UI route — for OpenClaw operator-UI embedded
        // consumers (plugin-contributed `chat.surface` slot, etc.) that
        // already hold a gateway token and shouldn't need a second pairing
        // dance. Gateway validates operator scope before our handler runs.
        mod.registerPluginHttpRoute({
          path: "/v1/clawg-ui/operator",
          auth: "gateway",
          match: "exact",
          pluginId: "clawg-ui",
          handler: createOperatorAguiHttpHandler(api),
        });
      })
      .catch((err: unknown) => {
        console.error("[clawg-ui] failed to register HTTP routes:", err);
      });

    api.on("before_tool_call", handleBeforeToolCall);
    api.on("tool_result_persist", handleToolResultPersist);

    // CLI commands for device management
    api.registerCli(
      ({ program }: { program: Command }) => {
        const clawgUi = program
          .command("clawg-ui")
          .description("CLAWG-UI (AG-UI) channel commands");

        clawgUi
          .command("devices")
          .description("List approved devices")
          .action(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK types lag behind runtime
            const devices = await (api.runtime.channel.pairing.readAllowFromStore as (arg: any) => Promise<string[]>)({ channel: "clawg-ui" });
            if (devices.length === 0) {
              console.log("No approved devices.");
              return;
            }
            console.log("Approved devices:");
            for (const deviceId of devices) {
              console.log(`  ${deviceId}`);
            }
          });
      },
      { commands: ["clawg-ui"] },
    );
  },
};

export default plugin;
