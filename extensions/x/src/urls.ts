import { LinkifyIt } from "linkify-it";
import tlds from "tlds" with { type: "json" };

const links = new LinkifyIt({ fuzzyLink: true, tlds });

export function findXUrls(text: string) {
  return (links.match(text) ?? []).filter(
    (match) => !match.schema || ["http:", "https:", "//"].includes(match.schema),
  );
}
