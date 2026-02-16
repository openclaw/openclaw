import { Type } from "@sinclair/typebox";
import { DISPATCH_TOOL_POLICIES } from "../../shared/authorization-policy.mjs";
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
  const actorRoleSchema = Type.String({ minLength: 1 });
  const payloadSchema = Type.Object({}, { additionalProperties: true });
  const commonEnvelopeFields = {
    actor_id: Type.String({ minLength: 1 }),
    actor_role: Type.Optional(actorRoleSchema),
    actor_type: Type.Optional(actorTypeSchema),
    request_id: Type.Optional(Type.String({ minLength: 1 })),
    correlation_id: Type.Optional(Type.String({ minLength: 1 })),
    trace_id: Type.Optional(Type.String({ minLength: 1 })),
    trace_parent: Type.Optional(Type.String({ minLength: 1 })),
    trace_state: Type.Optional(Type.String({ minLength: 1 })),
  };

  const toolDescriptions = {
    "ticket.create": "Create a ticket via dispatch-api.",
    "ticket.blind_intake": "Create a blind intake ticket via dispatch-api.",
    "ticket.triage": "Triage a ticket via dispatch-api.",
    "schedule.propose": "Propose schedule windows via dispatch-api.",
    "schedule.confirm": "Confirm a schedule window via dispatch-api.",
    "assignment.dispatch": "Dispatch assignment via dispatch-api.",
    "tech.check_in": "Record technician check-in via dispatch-api.",
    "tech.request_change": "Submit technician change request via dispatch-api.",
    "approval.decide": "Approve or deny a change request via dispatch-api.",
    "closeout.add_evidence": "Attach closeout evidence via dispatch-api.",
    "closeout.candidate": "Run candidate closeout automation via dispatch-api.",
    "qa.verify": "Verify closeout package via dispatch-api.",
    "billing.generate_invoice": "Generate invoice state transition via dispatch-api.",
    "ticket.get": "Read ticket snapshot via dispatch-api.",
    "closeout.list_evidence": "Read evidence items via dispatch-api.",
    "ticket.timeline": "Read ordered audit timeline via dispatch-api.",
    "dispatcher.cockpit":
      "Read dispatcher cockpit queue and mapped action surface via dispatch-api.",
    "tech.job_packet":
      "Read technician packet, timeline, evidence, and closeout gate status via dispatch-api.",
  } as const;

  const buildToolParameters = (policy: { mutating: boolean; requires_ticket_id: boolean }) => {
    const properties: Record<string, unknown> = { ...commonEnvelopeFields };
    if (policy.requires_ticket_id) {
      properties.ticket_id = Type.String({ minLength: 1 });
    }
    if (policy.mutating) {
      properties.payload = payloadSchema;
    }
    return Type.Object(properties, { additionalProperties: false });
  };

  const asOpenAIFriendlyToolName = (toolName: string) => toolName.replace(/\./g, "_");

  type ToolDefinition = {
    name: string;
    dispatchName: string;
    description: string;
    parameters: unknown;
  };

  const toolDefinitions = Object.values(DISPATCH_TOOL_POLICIES)
    .map(
      (policy) =>
        ({
          name: asOpenAIFriendlyToolName(policy.tool_name),
          dispatchName: policy.tool_name,
          description:
            toolDescriptions[policy.tool_name as keyof typeof toolDescriptions] ??
            `Invoke ${policy.tool_name} via dispatch-api.`,
          parameters: buildToolParameters(policy),
        }) as ToolDefinition,
    )
    .toSorted((left, right) => left.name.localeCompare(right.name));

  const toolStatus = {
    tool_names: toolDefinitions.map((tool) => tool.dispatchName),
    plugin: "dispatch-tools",
  };

  const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const baseUrl =
    typeof cfg.baseUrl === "string" && cfg.baseUrl.trim() !== "" ? cfg.baseUrl.trim() : null;
  const token =
    typeof cfg.token === "string" && cfg.token.trim() !== "" ? cfg.token.trim() : undefined;
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
    const dispatchName = tool.dispatchName;
    api.registerTool(
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const actorId = readString(params, "actor_id");
            const actorRole = readString(params, "actor_role") ?? "dispatcher";
            const result = await invokeDispatchAction({
              baseUrl,
              token,
              timeoutMs,
              logger: api.logger,
              toolName: dispatchName,
              actorId,
              actorRole,
              actorType: readString(params, "actor_type"),
              requestId: readString(params, "request_id"),
              correlationId: readString(params, "correlation_id"),
              traceId: readString(params, "trace_id"),
              traceParent: readString(params, "trace_parent"),
              traceState: readString(params, "trace_state"),
              ticketId: readString(params, "ticket_id"),
              payload: asObject(params.payload),
            });
            return toToolResult(result);
          } catch (error) {
            return toToolError(error, dispatchName);
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
