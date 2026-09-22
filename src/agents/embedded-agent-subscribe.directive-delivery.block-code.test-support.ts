export const settledParagraph =
  "Another paragraph is visible before the next streaming update.\n\n";

export const blockDirectiveCases = [
  {
    name: "ordinary continuations directly after completed fenced code",
    chunks: [
      "```text\n[[reply_to:example-id]]\n```\n",
      "An adjacent paragraph follows the completed example. ",
      "The remaining explanation stays ordinary prose.\n\n",
    ],
    marker: "[[reply_to:example-id]]",
    literal: true,
    textOnly: true,
  },
  {
    name: "ordinary continuations directly after completed indented code",
    chunks: [
      "Example.\n\n    [[reply_to:example-id]]\n",
      "An adjacent paragraph follows the completed example. ",
      "The remaining explanation stays ordinary prose.\n\n",
    ],
    marker: "[[reply_to:example-id]]",
    literal: true,
    textOnly: true,
  },
  {
    name: "continuations inside a still-open fenced example",
    chunks: [
      "```text\n[[reply_to:example-id]]\n\n",
      "Ordinary-looking text remains inside this open fence.\n",
      "[[reply_to:still-literal]]\n",
      "```\n\n",
    ],
    marker: "[[reply_to:example-id]]",
    literal: true,
    textOnly: true,
  },
  {
    name: "continuations inside an indented example after a blank line",
    chunks: [
      "Example.\n\n    [[reply_to:example-id]]\n\n",
      "    Another indented line continues this code block.\n",
      "    [[reply_to:still-literal]]\n",
      "\nOrdinary prose begins after the example.\n\n",
    ],
    marker: "[[reply_to:example-id]]",
    literal: true,
    textOnly: true,
  },
  {
    name: "a later split reply directive after completed block code",
    chunks: [
      "```text\n[[reply_to:example-id]]\n```\n\n" + settledParagraph,
      "Continue with ordinary prose.\n\n",
      "[",
      "[reply_to:",
      "later-id]]Continue after reply intent.\n\n",
    ],
    marker: "[[reply_to:later-id]]",
    replyToId: "later-id",
    textOnly: true,
  },
] as const;
