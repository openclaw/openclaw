import type { LineChannelData } from "openclaw/plugin-sdk";

/**
 * Parses embedded directives like [[quick_replies: ...]] from the text.
 * Returns the cleaned text and any extracted channel data.
 */
export function parseLineDirectives(text: string): {
  text: string;
  lineData: LineChannelData;
} {
  let cleanedText = text;
  const lineData: LineChannelData = {};

  // 1. Quick Replies: [[quick_replies: Option 1, Option 2]]
  // Regex captures content inside [[quick_replies: ...]]
  // Handles multiline (s flag equivalent via [\s\S])
  const qrRegex = /\[\[quick_replies:\s*([\s\S]+?)\]\]/i;
  const qrMatch = cleanedText.match(qrRegex);
  if (qrMatch) {
    const content = qrMatch[1];
    // Split by comma, trim whitespace
    const replies = content
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (replies.length > 0) {
      lineData.quickReplies = replies;
    }
    // Remove the directive from text
    cleanedText = cleanedText.replace(qrMatch[0], "");
  }

  // 2. Location: [[location: Title | Address | lat | long]]
  const locRegex =
    /\[\[location:\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([0-9.-]+)\s*\|\s*([0-9.-]+)\s*\]\]/i;
  const locMatch = cleanedText.match(locRegex);
  if (locMatch) {
    lineData.location = {
      title: locMatch[1].trim(),
      address: locMatch[2].trim(),
      latitude: Number.parseFloat(locMatch[3]),
      longitude: Number.parseFloat(locMatch[4]),
    };
    cleanedText = cleanedText.replace(locMatch[0], "");
  }

  // 3. Confirm: [[confirm: Question? | YesLabel | NoLabel]]
  const confirmRegex = /\[\[confirm:\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\]\]/i;
  const confirmMatch = cleanedText.match(confirmRegex);
  if (confirmMatch) {
    lineData.templateMessage = {
      type: "confirm",
      text: confirmMatch[1].trim(),
      confirmLabel: confirmMatch[2].trim(),
      confirmData: "yes", // Simple default
      cancelLabel: confirmMatch[3].trim(),
      cancelData: "no", // Simple default
      altText: confirmMatch[1].trim(),
    };
    cleanedText = cleanedText.replace(confirmMatch[0], "");
  }

  // 4. Buttons: [[buttons: Title | Text | Label:Action; Label:Action...]]
  // Uses semicolon as delimiter to support commas in label/data values
  const btnRegex = /\[\[buttons:\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([\s\S]+?)\]\]/i;
  const btnMatch = cleanedText.match(btnRegex);
  if (btnMatch) {
    const title = btnMatch[1].trim();
    const body = btnMatch[2].trim();
    const actionsRaw = btnMatch[3].split(";");
    const actions = actionsRaw.map((a) => {
      const parts = a.split(":"); // Label:Data or Label:http...
      const label = parts[0].trim();
      const value = parts.slice(1).join(":").trim();
      if (value.startsWith("http")) {
        return { type: "uri" as const, label, uri: value };
      }
      return { type: "postback" as const, label, data: value };
    });

    if (actions.length > 0) {
      lineData.templateMessage = {
        type: "buttons",
        title,
        text: body,
        actions,
        altText: title,
      };
    }
    cleanedText = cleanedText.replace(btnMatch[0], "");
  }

  // Clean up residual whitespace/newlines
  cleanedText = cleanedText.trim();

  return { text: cleanedText, lineData };
}
