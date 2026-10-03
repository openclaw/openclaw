import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { QuestionResourcePreview, QuestionResourceInput } from "./schema/questions.js";

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
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
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

export function readQuestionResourceInput(value: unknown): QuestionResourceInput | undefined {
  if (
    !isRecord(value) ||
    (value.viewId !== undefined &&
      (typeof value.viewId !== "string" || !value.viewId || value.viewId.length > 128)) ||
    (value.selection !== "explicit" && value.selection !== "implicit")
  ) {
    return undefined;
  }
  let userOptions: QuestionResourceInput["userOptions"];
  if (value.userOptions !== undefined) {
    if (
      !isRecord(value.userOptions) ||
      (value.userOptions.kind !== "file" && value.userOptions.kind !== "directory")
    ) {
      return undefined;
    }
    const accept = value.userOptions.accept;
    if (
      accept !== undefined &&
      (!Array.isArray(accept) ||
        accept.length > 32 ||
        !accept.every((entry): entry is string => typeof entry === "string" && entry.length <= 128))
    ) {
      return undefined;
    }
    userOptions = {
      kind: value.userOptions.kind,
      ...(Array.isArray(accept)
        ? { accept: accept.filter((entry): entry is string => typeof entry === "string") }
        : {}),
    };
  }
  return {
    ...(typeof value.viewId === "string" ? { viewId: value.viewId } : {}),
    selection: value.selection,
    ...(userOptions ? { userOptions } : {}),
  };
}
