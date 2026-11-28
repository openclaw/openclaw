/** A long synthetic answer whose fences, tables, and inline tokens cross delta boundaries. */
export function createControlUiStreamingReply(
  deltasPerSecond = 30,
  content: "markdown" | "tool-code" | "mixed" = "markdown",
) {
  const text =
    content === "tool-code"
      ? `The tool output and this code block grow together.\n\n\`\`\`typescript\n${Array.from(
          { length: 180 },
          (_, index) => `export const checkpoint${index + 1} = ${index + 1};\n`,
        ).join("")}\`\`\`\n\nStreaming code complete.\n`
      : Array.from({ length: 24 }, (_, index) => {
          const section = index + 1;
          return `## Checkpoint ${section}\n\nThe streaming renderer should retain completed content while the next paragraph grows. This checkpoint includes **important details**, an [example link](https://example.com/checkpoint/${section}), and inline \`code\` without moving the surrounding conversation.\n\n\`\`\`typescript\nexport function checkpoint${section}(values: readonly number[]) {\n  return values.filter((value) => value < 100).map((value) => ({ value, doubled: value * 2 }));\n}\n\`\`\`\n\n| Measurement | Expected behavior |\n| --- | --- |\n| Completed blocks | Retain their DOM |\n| Open paragraph | Update in place |\n| Checkpoint | ${section} of 24 |\n\nThe result is ready for the next checkpoint.\n\n`;
        }).join("");
  // A deterministic variable chunk size avoids aligning deltas with Markdown block boundaries.
  const deltas: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    offset = Math.min(text.length, offset + 12 + ((deltas.length * 17) % 25));
    deltas.push(text.slice(0, offset));
  }
  return {
    text,
    deltas,
    deltasPerSecond,
    growingTool: content === "tool-code",
    ...(content === "mixed"
      ? {
          mixed: {
            reasoning:
              "Compare the synthetic checkpoints, verify every tool result, then inspect the attached image.",
            toolCount: 24,
            imageUrl:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfJaEY0miH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBSsoBS93KSLIAAAAASUVORK5CYII=",
          },
        }
      : {}),
  };
}
