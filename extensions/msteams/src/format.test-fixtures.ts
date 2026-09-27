export const teamsQuotedRawTable =
  "> | Name | State |\r\n> |---|---|\r\n> | [deploy](https://host/a) | ready |";

export const teamsQuotedTableReply = {
  source: `# Status\r\n\r\n${teamsQuotedRawTable}\n\n# Next`,
  expected: `**Status**\n\n${teamsQuotedRawTable}\n\n**Next**`,
};

export const teamsMarkdownDeliveryCases = [
  { name: "plain text", source: "hello", expected: "hello" },
  { name: "quoted CRLF table", ...teamsQuotedTableReply },
  {
    name: "table-looking code inside an open list fence",
    source: "- ```\n  code\n\n  > | A | B |\n  > |---|---|\n  > | x | y |",
    expected: "• ```\ncode\n\n> | A | B |\n> |---|---|\n> | x | y |\n```",
  },
  {
    name: "raw table after list-fence outdent",
    source: "- ```\n  code\n\n> >   | A | B |\n> >   |---|---|\n> >   | x | y |",
    expected: "• ```\ncode\n\n```>   | A | B |\n> >   |---|---|\n> >   | x | y |",
  },
];
