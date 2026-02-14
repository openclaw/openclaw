import { Type } from "@sinclair/typebox";
import { DispatchBridgeError, invokeDispatchAction } from "./bridge.mjs";

/**
 * Closed dispatch tool bridge plugin.
 *
 * This plugin only exposes an allowlisted set of dispatch tools and forwards
 * calls to dispatch-api. Unknown/forbidden actions fail closed.
 */
export default function register(api: {
  pluginConfig?: Record<string, unknown>;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  registerTool: (
    spec: {
      name: string;
      description: string;
      parameters: unknown;
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    },
    opts?: { optional?: boolean },
  ) => void;
}) {
  const actorTypeSchema = Type.Union([
    Type.Literal("HUMAN"),
    Type.Literal("AGENT"),
    Type.Literal("SERVICE"),
    Type.Literal("SYSTEM"),
  ]);
  const payloadSchema = Type.Object({}, { additionalProperties: true });
  const commonEnvelopeFields = {
    actor_id: Type.String({ minLength: 1 }),
    actor_role: Type.String({ minLength: 1 }),
    actor_type: Type.Optional(actorTypeSchema),
    request_id: Type.Optional(Type.String({ minLength: 1 })),
    correlation_id: Type.Optional(Type.String({ minLength: 1 })),
    trace_id: Type.Optional(Type.String({ minLength: 1 })),
  };

  const ticketCreateParameters = Type.Object(
    {
      ...commonEnvelopeFields,
      payload: payloadSchema,
    },
    { additionalProperties: false },
  );

  const ticketScopedMutationParameters = Type.Object(
    {
      ...commonEnvelopeFields,
      ticket_id: Type.String({ minLength: 1 }),
      payload: payloadSchema,
    },
    { additionalProperties: false },
  );

  const timelineParameters = Type.Object(
    {
      ...commonEnvelopeFields,
      ticket_id: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  );

  const toolDefinitions = [
    {
      name: "ticket.create",
      description: "Create a ticket via dispatch-api.",
      parameters: ticketCreateParameters,
    },
    {
      name: "ticket.triage",
      description: "Triage a ticket via dispatch-api.",
      parameters: ticketScopedMutationParameters,
    },
    {
      name: "schedule.confirm",
      description: "Confirm a schedule window via dispatch-api.",
      parameters: ticketScopedMutationParameters,
    },
    {
      name: "assignment.dispatch",
      description: "Dispatch assignment via dispatch-api.",
      parameters: ticketScopedMutationParameters,
    },
    {
      name: "ticket.timeline",
      description: "Read ordered audit timeline via dispatch-api.",
      parameters: timelineParameters,
    },
  ];

  const toolStatus = {
    tool_names: toolDefinitions.map((tool) => tool.name),
    plugin: "dispatch-tools",
  };

  const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const baseUrl =
    typeof cfg.baseUrl === "string" && cfg.baseUrl.trim() !== ""
      ? cfg.baseUrl.trim()
      : null;
  const token = typeof cfg.token === "string" && cfg.token.trim() !== "" ? cfg.token.trim() : undefined;
  const timeoutMs =
    typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 10_000;

  api.registerTool(
    {
      name: "dispatch_contract_status",
      description: "Returns closed dispatch tool bridge status.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const statusPayload = {
          ...toolStatus,
          configured: Boolean(baseUrl),
          base_url: baseUrl,
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(statusPayload, null, 2),
            },
          ],
          details: statusPayload,
        };
      },
    },
    { optional: true },
  );

  if (!baseUrl) {
    api.logger?.warn?.(
      "dispatch-tools: baseUrl missing in plugin config; bridge tools not registered (fail closed).",
    );
    return;
  }

  const readString = (params: Record<string, unknown>, key: string): string | null =>
    typeof params[key] === "string" && params[key].trim() !== "" ? params[key].trim() : null;

  const asObject = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

  const toToolResult = (payload: unknown, isError = false) => ({
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
    isError,
  });

  const toToolError = (error: unknown, toolName: string) => {
    if (error instanceof DispatchBridgeError) {
      return toToolResult(error.toObject(), true);
    }
    return toToolResult(
      {
        error: {
          code: "BRIDGE_INTERNAL_ERROR",
          status: 500,
          message: error instanceof Error ? error.message : String(error),
          tool_name: toolName,
        },
      },
      true,
    );
  };

  for (const tool of toolDefinitions) {
    api.registerTool(
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const actorId = readString(params, "actor_id");
            const actorRole = readString(params, "actor_role");
            const result = await invokeDispatchAction({
              baseUrl,
              token,
              timeoutMs,
              logger: api.logger,
              toolName: tool.name,
              actorId,
              actorRole,
              actorType: readString(params, "actor_type"),
              requestId: readString(params, "request_id"),
              correlationId: readString(params, "correlation_id"),
              traceId: readString(params, "trace_id"),
              ticketId: readString(params, "ticket_id"),
              payload: asObject(params.payload),
            });
            return toToolResult(result);
          } catch (error) {
            return toToolError(error, tool.name);
          }
        },
      },
      { optional: true },
    );
  }

  api.logger?.info?.(
    `dispatch-tools: registered ${toolDefinitions.length} closed bridge tools against ${baseUrl}`,
  );
}
