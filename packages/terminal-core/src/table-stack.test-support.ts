import { renderTable } from "./table.js";

const shape = process.argv[2];
const output = renderTable({
  width: 7,
  columns: [{ key: "Key", header: "Key" }],
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
const delimiter = lines[1]?.[0];
console.log(
  JSON.stringify({
    lineCount: lines.length,
    rows: lines.filter((line) => line === `${delimiter} row ${delimiter}`).length,
    softWrapRowsMatch:
      lines[3] === `${delimiter} a   ${delimiter}` &&
      lines[4] === `${delimiter} ` + "\u200b".repeat(150_000) + `b   ${delimiter}`,
  }),
);
