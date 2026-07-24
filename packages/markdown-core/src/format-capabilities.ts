export type FormatConstruct =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "spoiler"
  | "codeInline"
  | "codeBlock"
  | "codeLanguage"
  | "linkLabel"
  | "heading"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "table"
  | "blockquote"
  | "image"
  | "mention";

export type ConstructSupport = "native" | "fallback" | "strip";

/** Static formatting capabilities declared by an outbound channel. */
export type FormatCapabilityProfile = {
  mechanism: "markdown" | "html" | "ranges" | "blocks" | "plain";
  constructs: Record<FormatConstruct, ConstructSupport>;
  chunk: {
    limit: number;
    unit: "chars" | "utf16" | "bytes";
    hardCap?: number;
  };
};
