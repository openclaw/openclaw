import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../src/agents/embedded-agent-utils.ts";

const cases = [
  {
    name: "inline image destination close",
    prefix: "![example `x\n[tool:read] {}\nx` label",
    suffix: "](/url)\n",
  },
  {
    name: "multiline reference title close",
    prefix: '[id]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\n',
    suffix: '"',
  },
  {
    name: "next-line reference destination",
    prefix: "![example `x\n[tool:read] {}\nx`][id]\n\n[id]:\n",
    suffix: "/url\n",
  },
];

for (const example of cases) {
  const stream = createAssistantVisibleStreamText("final_answer");
  const pending = stream.append(example.prefix);
  const corrected = stream.append(example.suffix);
  const expected = sanitizeAssistantVisibleStreamText(
    example.prefix + example.suffix,
    "final_answer",
  );
  if (!pending.text.includes("[tool:read] {}")) {
    throw new Error(`${example.name}: pending call did not reach the final-answer projector`);
  }
  if (corrected.delta !== null || corrected.text.includes("[tool:read] {}")) {
    throw new Error(`${example.name}: ownership correction did not replace the pending output`);
  }
  if (corrected.text !== expected) {
    throw new Error(`${example.name}: final output differs from canonical sanitization`);
  }
  console.log(
    JSON.stringify({
      case: example.name,
      phase: "final_answer",
      pendingCallObserved: true,
      correction: "replacement",
      finalText: corrected.text,
    }),
  );
}
