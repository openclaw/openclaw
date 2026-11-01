// Table shapes shared by the Feishu send and reply suites. A card draws the native shapes,
// cannot draw the undrawable ones (a quote or a list marker owns them), and the non-table
// shapes are prose that only looks like a table.
export const pipelessTableMarkdown = "Name | Role\n--- | ---\nAda | Lead";
export const nativeTableShapes = [
  { shape: "pipeless", text: pipelessTableMarkdown },
  { shape: "leading-pipe-only", text: "| Name | Role\n| --- | ---\n| Ada | Lead" },
  { shape: "trailing-pipe-only", text: "Name | Role |\n--- | --- |\nAda | Lead |" },
  { shape: "CRLF pipeless", text: pipelessTableMarkdown.replaceAll("\n", "\r\n") },
  { shape: "aligned-delimiter", text: "Name | Role\n:--- | ---:\nAda | Lead" },
] as const;
export const undrawableTableShapes = [
  {
    shape: "blockquote",
    text: "> Name | Role\n> --- | ---\n> Ada | Lead",
    posted: "> ```\n> | Name | Role |\n> | ---- | ---- |\n> | Ada  | Lead |\n> ```",
  },
  {
    shape: "list-item",
    text: "- Name | Role\n  --- | ---\n  Ada | Lead",
    posted: "```\n| - Name | Role |\n| ------ | ---- |\n| Ada    | Lead |\n```",
  },
] as const;
export const nonTableShapes = [
  { shape: "header wider than delimiter", text: "| Name | Role |\n| --- |\n| Ada | Lead |" },
  { shape: "delimiter wider than header", text: "| Name |\n| --- | --- |\n| Ada | Lead |" },
  { shape: "dashless delimiter", text: "| Name | Role |\n| : | : |\n| Ada | Lead |" },
  {
    shape: "blank line before delimiter",
    text: "| Name | Role |\n\n| --- | --- |\n| Ada | Lead |",
  },
] as const;
