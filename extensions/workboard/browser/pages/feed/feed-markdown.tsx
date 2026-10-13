/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";

// Agent text renders as JSX text and elements only: no HTML from card content reaches the DOM.
const INLINE_PATTERN =
  /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)]+)/g;

function inline(text: string): JSX.Element[] {
  const parts: JSX.Element[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    parts.push(text.slice(last, index));
    if (token.startsWith("**")) {
      parts.push(<strong>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      parts.push(<code>{token.slice(1, -1)}</code>);
    } else {
      const split = token.startsWith("[") ? token.indexOf("](") : -1;
      const href = split < 0 ? token : token.slice(split + 2, -1);
      parts.push(
        <a href={href} target="_blank" rel="noreferrer noopener">
          {split < 0 ? token : token.slice(1, split)}
        </a>,
      );
    }
    last = index + token.length;
  }
  parts.push(text.slice(last));
  return parts;
}

type Block = { kind: "p" | "ul" | "ol" | "h"; lines: string[] };

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  // A blank line or heading ends the open block, so the next line starts a new one.
  let blockOpen = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim() || heading) {
      blockOpen = false;
      if (heading?.[1]) {
        blocks.push({ kind: "h", lines: [heading[1]] });
      }
      continue;
    }
    const kind = bullet ? "ul" : ordered ? "ol" : "p";
    let current = blockOpen ? blocks.at(-1) : undefined;
    if (current?.kind !== kind) {
      current = { kind, lines: [] };
      blocks.push(current);
    }
    blockOpen = true;
    current.lines.push(bullet?.[1] ?? ordered?.[1] ?? line);
  }
  return blocks;
}

/** Light markdown for agent-written Feed text: paragraphs, lists, bold, code and links. */
export function FeedMarkdown(props: { text: string; class?: string | undefined }) {
  return (
    <div class={["wb-feed-md", props.class]}>
      <For each={toBlocks(props.text)} keyed={false}>
        {(block) => (
          <Show
            when={block().kind === "ul" || block().kind === "ol"}
            fallback={
              <p class={{ "wb-feed-md__heading": block().kind === "h" }}>
                <For each={block().lines} keyed={false}>
                  {(line, index) => (
                    <>
                      {index > 0 ? <br /> : undefined}
                      {inline(line())}
                    </>
                  )}
                </For>
              </p>
            }
          >
            {block().kind === "ul" ? (
              <ul>
                <For each={block().lines} keyed={false}>
                  {(line) => <li>{inline(line())}</li>}
                </For>
              </ul>
            ) : (
              <ol>
                <For each={block().lines} keyed={false}>
                  {(line) => <li>{inline(line())}</li>}
                </For>
              </ol>
            )}
          </Show>
        )}
      </For>
    </div>
  );
}
