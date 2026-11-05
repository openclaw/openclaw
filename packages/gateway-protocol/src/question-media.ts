import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { QuestionResourcePreview } from "./schema/questions.js";

/** Images are rendered by clients, never fetched by the Gateway. */
export function isQuestionThumbnail(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 65_536 || /[\s\p{Cc}]/u.test(value)) {
    return false;
  }
  if (
    /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    return true;
  }
  const url = URL.parse(value);
  return url?.protocol === "https:" && !url.username && !url.password;
}

export function readQuestionResourcePreview(value: unknown): QuestionResourcePreview | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const bounded = (entry: unknown, max = 2048): entry is string =>
    typeof entry === "string" &&
    entry.trim().length > 0 &&
    entry.length <= max &&
    !/\p{Cc}/u.test(entry);
  if (value.type === "mcp_app_tool" && bounded(value.name, 256)) {
    if (
      value.arguments !== undefined &&
      (!isRecord(value.arguments) || JSON.stringify(value.arguments).length > 65536)
    ) {
      return undefined;
    }
    return {
      type: "mcp_app_tool",
      name: value.name,
      ...(isRecord(value.arguments) ? { arguments: value.arguments } : {}),
    };
  }
  if (value.type !== "resource_link" || !bounded(value.uri) || !bounded(value.name, 256)) {
    return undefined;
  }
  if (!URL.canParse(value.uri)) {
    return undefined;
  }
  if (
    [value.title, value.description, value.mimeType].some(
      (entry) => entry !== undefined && !bounded(entry),
    )
  ) {
    return undefined;
  }
  return {
    type: "resource_link",
    uri: value.uri,
    name: value.name,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
  };
}
