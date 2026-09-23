import { renderTable } from "./table.js";

const shape = process.argv[2];
const output = renderTable({
  border: "ascii",
  columns: [{ key: "Key", header: "Key", maxWidth: 5 }],
  rows:
    shape === "rows"
      ? Array.from({ length: 150_000 }, () => ({ Key: "row" }))
      : [
          {
            Key:
              shape === "wrapped lines"
                ? "row".repeat(150_000)
                : "a  " + "\u200b".repeat(150_000) + "b",
          },
        ],
});
const lines = output.trimEnd().split("\n");
console.log(
  JSON.stringify({
    lineCount: lines.length,
    rows: lines.filter((line) => line === "| row |").length,
    header: lines[1],
    firstLine: lines[0],
    lastLine: lines.at(-1),
    softWrapRowsMatch:
      lines[3] === "| a   |" && lines[4] === "| " + "\u200b".repeat(150_000) + "b   |",
  }),
);
