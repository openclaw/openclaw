import { Scanner } from "./src/scanner.js";
import { redact } from "./src/redactor.js";
import { loadConfig } from "./src/config.js";
import type { GuardrailAction } from "./src/types.js";

const fogclaw = {
  id: "fogclaw",
  name: "FogClaw",
  description: "PII detection & custom entity redaction powered by DataFog",

  async register(api: any) {
    const rawConfig = api.pluginConfig ?? {};
    const config = loadConfig(rawConfig);

    if (!config.enabled) {
      api.logger?.info("[fogclaw] Plugin disabled via config");
      return;
    }

    const scanner = new Scanner(config);
    await scanner.initialize();

    // --- HOOK: Guardrail on incoming messages ---
    api.on("before_agent_start", async (event: any, ctx: any) => {
      const message = event.query ?? event.message ?? "";
      const result = await scanner.scan(message);

      if (result.entities.length === 0) return;

      // Check for any "block" actions
      for (const entity of result.entities) {
        const action: GuardrailAction =
          config.entityActions[entity.label] ?? config.guardrail_mode;

        if (action === "block") {
          ctx?.reply?.(
            `Message blocked: detected ${entity.label}. Please rephrase without sensitive information.`,
          );
          return { abort: true };
        }
      }

      // Check for any "warn" actions
      const warnings = result.entities.filter((e) => {
        const action = config.entityActions[e.label] ?? config.guardrail_mode;
        return action === "warn";
      });
      if (warnings.length > 0) {
        const types = [...new Set(warnings.map((w) => w.label))].join(", ");
        ctx?.notify?.(`PII detected: ${types}`);
      }

      // Apply redaction for "redact" action entities
      const toRedact = result.entities.filter((e) => {
        const action = config.entityActions[e.label] ?? config.guardrail_mode;
        return action === "redact";
      });
      if (toRedact.length > 0) {
        const redacted = redact(message, toRedact, config.redactStrategy);
        return { prependContext: redacted.redacted_text };
      }
    });

    // --- TOOL: On-demand scan ---
    api.registerTool({
      name: "fogclaw_scan",
      label: "Scan for PII",
      description:
        "Scan text for PII and custom entities. Returns detected entities with types, positions, and confidence scores.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Text to scan for entities",
          },
          custom_labels: {
            type: "array",
            items: { type: "string" },
            description:
              "Additional entity labels for zero-shot detection (e.g., ['competitor name', 'project codename'])",
          },
        },
        required: ["text"],
      },
      async execute(
        _toolCallId: string,
        params: { text: string; custom_labels?: string[] },
      ) {
        const result = await scanner.scan(params.text, params.custom_labels);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  entities: result.entities,
                  count: result.entities.length,
                  summary:
                    result.entities.length > 0
                      ? `Found ${result.entities.length} entities: ${[...new Set(result.entities.map((e) => e.label))].join(", ")}`
                      : "No entities detected",
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    });

    // --- TOOL: On-demand redact ---
    api.registerTool({
      name: "fogclaw_redact",
      label: "Redact PII",
      description:
        "Scan and redact PII/custom entities from text. Returns sanitized text with entities replaced.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Text to scan and redact",
          },
          strategy: {
            type: "string",
            description:
              'Redaction strategy: "token" ([EMAIL_1]), "mask" (****), or "hash" ([EMAIL_a1b2c3...])',
            enum: ["token", "mask", "hash"],
          },
          custom_labels: {
            type: "array",
            items: { type: "string" },
            description: "Additional entity labels for zero-shot detection",
          },
        },
        required: ["text"],
      },
      async execute(
        _toolCallId: string,
        params: { text: string; strategy?: "token" | "mask" | "hash"; custom_labels?: string[] },
      ) {
        const result = await scanner.scan(params.text, params.custom_labels);
        const redacted = redact(
          params.text,
          result.entities,
          params.strategy ?? config.redactStrategy,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  redacted_text: redacted.redacted_text,
                  entities_found: result.entities.length,
                  mapping: redacted.mapping,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    });

    api.logger?.info(
      `[fogclaw] Plugin registered — guardrail: ${config.guardrail_mode}, model: ${config.model}, custom entities: ${config.custom_entities.length}`,
    );
  },
};

export default fogclaw;
