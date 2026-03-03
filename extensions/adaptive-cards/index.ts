import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";

/**
 * Marker tags used to embed Adaptive Card JSON inside tool result text.
 * Mobile apps extract the card JSON between these markers and render it natively.
 * Channels that don't understand the markers show the fallback text.
 */
const CARD_OPEN_TAG = "<!--adaptive-card-->";
const CARD_CLOSE_TAG = "<!--/adaptive-card-->";

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { text },
  };
}

export default function register(api: OpenClawPluginApi) {
  api.registerTool({
    name: "adaptive_card",
    label: "Adaptive Card",
    description: [
      "Render an interactive Adaptive Card in the user's chat.",
      "Use this for structured content that benefits from visual layout:",
      "status dashboards, option selections, forms, progress tracking,",
      "data tables, fact sets, or any response where tapping is better than typing.",
      "",
      "The card renders natively on iOS (SwiftUI), Android (Jetpack Compose),",
      "and Teams (Bot Framework). Other channels see the fallback text.",
      "",
      "Card schema follows Adaptive Cards v1.5: https://adaptivecards.io/explorer/",
      "Common body element types: TextBlock, ColumnSet, FactSet, Image,",
      "Input.Text, Input.ChoiceSet, Input.Toggle, ProgressBar.",
      "Common action types: Action.Submit, Action.OpenUrl, Action.ShowCard.",
    ].join("\n"),
    parameters: Type.Object({
      body: Type.Array(Type.Unknown(), {
        description:
          "Array of Adaptive Card body elements. " +
          'Example: [{ "type": "TextBlock", "text": "Hello", "weight": "Bolder" }]',
      }),
      actions: Type.Optional(
        Type.Array(Type.Unknown(), {
          description:
            "Array of card actions (buttons). " +
            'Example: [{ "type": "Action.Submit", "title": "Approve", "data": { "choice": "yes" } }]',
        }),
      ),
      fallback_text: Type.Optional(
        Type.String({
          description:
            "Plain text shown on channels that cannot render cards (Telegram, IRC, etc.). " +
            "If omitted, a summary is auto-generated from the card body.",
        }),
      ),
      template_data: Type.Optional(
        Type.Unknown({
          description:
            "Data context for client-side template expansion. " +
            "Use ${expression} syntax in card body and pass data here.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const p = params as {
        body: unknown[];
        actions?: unknown[];
        fallback_text?: string;
        template_data?: unknown;
      };

      if (!Array.isArray(p.body) || p.body.length === 0) {
        return textResult("Error: card body must be a non-empty array of elements.");
      }

      const card: Record<string, unknown> = {
        type: "AdaptiveCard",
        version: "1.5",
        body: p.body,
      };
      if (Array.isArray(p.actions) && p.actions.length > 0) {
        card.actions = p.actions;
      }

      const cardJson = JSON.stringify(card);
      const fallback = p.fallback_text ?? generateFallbackText(p.body);
      const templateData = p.template_data ?? null;

      // Embed the card JSON between marker tags inside the tool result text.
      // The text survives gateway sanitization (which only truncates, doesn't strip).
      // Mobile apps extract the JSON between markers and render natively.
      // Channels that don't parse markers just show the fallback text.
      const markedText = [
        fallback,
        "",
        `${CARD_OPEN_TAG}${cardJson}${CARD_CLOSE_TAG}`,
        templateData
          ? `<!--adaptive-card-data-->${JSON.stringify(templateData)}<!--/adaptive-card-data-->`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: [{ type: "text" as const, text: markedText }],
        details: { adaptiveCard: cardJson, templateData },
      };
    },
  });

  // Command: /card for quick manual card testing
  api.registerCommand({
    name: "card",
    description: "Send a test Adaptive Card to verify rendering.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      if (args === "test" || !args) {
        const card = {
          type: "AdaptiveCard",
          version: "1.5",
          body: [
            { type: "TextBlock", text: "Adaptive Cards Test", weight: "Bolder", size: "Large" },
            {
              type: "FactSet",
              facts: [
                { title: "Platform", value: "OpenClaw" },
                { title: "Status", value: "Connected" },
                { title: "Version", value: "1.5" },
              ],
            },
            {
              type: "TextBlock",
              text: "If you see this as a native card, rendering works.",
              isSubtle: true,
            },
          ],
          actions: [{ type: "Action.Submit", title: "Confirm", data: { action: "test_confirm" } }],
        };
        const cardJson = JSON.stringify(card);
        return {
          text: `Adaptive Cards test card:\n\n${CARD_OPEN_TAG}${cardJson}${CARD_CLOSE_TAG}`,
        };
      }
      // Try to parse args as card JSON
      try {
        const card = JSON.parse(args);
        if (!card.type || card.type !== "AdaptiveCard") {
          return { text: 'Invalid card: must have "type": "AdaptiveCard".' };
        }
        const cardJson = JSON.stringify(card);
        return { text: `${CARD_OPEN_TAG}${cardJson}${CARD_CLOSE_TAG}` };
      } catch {
        return {
          text: [
            "Usage: /card [test | <card-json>]",
            "",
            "/card test   - Send a test card to verify rendering",
            "/card {...}  - Send a custom Adaptive Card JSON",
          ].join("\n"),
        };
      }
    },
  });
}

/**
 * Generate plain text fallback from card body elements.
 * Used when no explicit fallback_text is provided.
 */
function generateFallbackText(body: unknown[]): string {
  const lines: string[] = [];
  for (const element of body) {
    if (!element || typeof element !== "object") continue;
    const el = element as Record<string, unknown>;
    const type = typeof el.type === "string" ? el.type : "";
    switch (type) {
      case "TextBlock":
        if (typeof el.text === "string") lines.push(el.text);
        break;
      case "FactSet":
        if (Array.isArray(el.facts)) {
          for (const fact of el.facts) {
            const f = fact as Record<string, unknown>;
            if (typeof f.title === "string" && typeof f.value === "string") {
              lines.push(`${f.title}: ${f.value}`);
            }
          }
        }
        break;
      case "ColumnSet":
        if (Array.isArray(el.columns)) {
          for (const col of el.columns) {
            const c = col as Record<string, unknown>;
            if (Array.isArray(c.items)) {
              lines.push(generateFallbackText(c.items));
            }
          }
        }
        break;
      default:
        break;
    }
  }
  return lines.filter(Boolean).join("\n");
}
