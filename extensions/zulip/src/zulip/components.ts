/**
 * Zulip ocform component builder.
 *
 * Builds widget payloads for the custom `ocform` widget type and
 * creates registry entries for callback resolution.
 *
 * Mirrors the pattern in src/discord/components.ts but simplified
 * for Zulip's submessage-based callback model (buttons only).
 */
import * as crypto from "crypto";
import type { ZulipComponentEntry } from "./components-registry.js";

// --- Types ---

export type ZulipButtonStyle = "primary" | "secondary" | "success" | "danger";

export type ZulipComponentButtonSpec = {
  /** Button label text */
  label: string;
  /** Optional callback payload preserved in the registry/inbound event text. */
  callbackData?: string;
  /** Visual style */
  style?: ZulipButtonStyle;
  /** If true, button can be clicked multiple times */
  reusable?: boolean;
  /** Restrict to specific Zulip user IDs */
  allowedUsers?: number[];
};

export type ZulipComponentSpec = {
  /** Heading text displayed above buttons */
  heading?: string;
  /** Button definitions */
  buttons: ZulipComponentButtonSpec[];
};

export type ZulipWidgetContent = {
  widget_type: "ocform";
  extra_data: {
    type: "buttons";
    heading: string;
    choices: Array<{
      id: string;
      label: string;
      style: string;
    }>;
  };
};

export type ZulipComponentBuildResult = {
  /** JSON-serialized widget_content for the Zulip API */
  widgetContent: ZulipWidgetContent;
  /** Registry entries to register after sending */
  entries: ZulipComponentEntry[];
};

// --- ID generation ---

function generateButtonId(): string {
  return `btn_${crypto.randomBytes(6).toString("base64url")}`;
}

// --- Builder ---

/**
 * Build a Zulip ocform widget payload and registry entries from a component spec.
 *
 * Usage:
 * ```ts
 * const result = buildZulipWidgetContent({
 *   spec: { heading: "Confirm?", buttons: [{ label: "Yes", style: "success" }] },
 *   sessionKey: "agent:zulip:stream:ops:topic:deploy",
 *   agentId: "main",
 *   accountId: "archie",
 * });
 * // Send message with widget_content = JSON.stringify(result.widgetContent)
 * // Then register entries: registerZulipComponentEntries({ entries: result.entries })
 * ```
 */
export function buildZulipWidgetContent(params: {
  spec: ZulipComponentSpec;
  sessionKey: string;
  agentId: string;
  accountId: string;
  replyTo?: string;
  chatType?: "channel" | "direct";
}): ZulipComponentBuildResult {
  const { spec, sessionKey, agentId, accountId, replyTo, chatType } = params;

  if (!spec.buttons || spec.buttons.length === 0) {
    throw new Error("ocform spec must have at least one button");
  }
  if (spec.buttons.length > 25) {
    throw new Error("ocform spec must have at most 25 buttons");
  }

  const entries: ZulipComponentEntry[] = [];
  const choices: ZulipWidgetContent["extra_data"]["choices"] = [];

  for (const btn of spec.buttons) {
    if (!btn.label || btn.label.trim().length === 0) {
      throw new Error("Button label must be non-empty");
    }

    const id = generateButtonId();
    const style = btn.style ?? "primary";

    choices.push({ id, label: btn.label, style });

    entries.push({
      id,
      label: btn.label,
      style,
      sessionKey,
      agentId,
      accountId,
      callbackData: btn.callbackData,
      replyTo,
      chatType,
      reusable: btn.reusable,
      allowedUsers: btn.allowedUsers,
    });
  }

  const widgetContent: ZulipWidgetContent = {
    widget_type: "ocform",
    extra_data: {
      type: "buttons",
      heading: spec.heading ?? "",
      choices,
    },
  };

  return { widgetContent, entries };
}

/**
 * Parse and validate a raw component spec from an agent tool call.
 */
export function readZulipComponentSpec(raw: unknown): ZulipComponentSpec {
  if (!raw || typeof raw !== "object") {
    throw new Error("Component spec must be an object");
  }
  const obj = raw as Record<string, unknown>;

  const heading = typeof obj.heading === "string" ? obj.heading : undefined;

  if (!Array.isArray(obj.buttons)) {
    throw new Error("Component spec must have a 'buttons' array");
  }

  const rawButtons = obj.buttons.flatMap((button) => (Array.isArray(button) ? button : [button]));
  const buttons: ZulipComponentButtonSpec[] = [];
  for (const btn of rawButtons) {
    if (!btn || typeof btn !== "object") {
      throw new Error("Each button must be an object");
    }
    const b = btn as Record<string, unknown>;
    const label =
      typeof b.label === "string" ? b.label : typeof b.text === "string" ? b.text : undefined;
    if (!label || label.trim().length === 0) {
      throw new Error("Each button must have a non-empty 'label' or 'text' string");
    }
    const style = typeof b.style === "string" ? (b.style as ZulipButtonStyle) : undefined;
    const validStyles = new Set(["primary", "secondary", "success", "danger"]);
    if (style && !validStyles.has(style)) {
      throw new Error(
        `Invalid button style '${style}', must be one of: ${[...validStyles].join(", ")}`,
      );
    }

    buttons.push({
      label,
      callbackData:
        typeof b.callbackData === "string"
          ? b.callbackData
          : typeof b.callback_data === "string"
            ? b.callback_data
            : undefined,
      style,
      reusable: typeof b.reusable === "boolean" ? b.reusable : undefined,
      allowedUsers: Array.isArray(b.allowedUsers) ? b.allowedUsers : undefined,
    });
  }

  return { heading, buttons };
}

/**
 * Format a component callback event as human-readable text for the agent.
 */
export function formatZulipComponentEventText(params: {
  label: string;
  buttonId: string;
  senderName: string;
  callbackData?: string;
}): string {
  const callbackSuffix = params.callbackData ? `, callback_data: ${params.callbackData}` : "";
  return `Clicked '${params.label}' (button_id: ${params.buttonId}${callbackSuffix})`;
}
