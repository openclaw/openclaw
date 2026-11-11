import DOMPurify from "dompurify";
import { markdown, type LinkResolution } from "./markdown-links.js";

// True when `href` holds a C0 control character, space or DEL.
const hasControlOrSpace = (href: string) => {
  for (let i = 0; i < href.length; i++) {
    const code = href.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
};

/** Render portable page content without granting it native-plugin privileges. */
export function markdownView(
  source: string,
  openRecord: (id: string) => void,
  links: LinkResolution[] = [],
): HTMLElement {
  const root = document.createElement("div");
  root.className = "knowledge-markdown";
  root.append(
    // SAFETY: markdown is a Marked instance configured with async: false, so parse returns a string.
    DOMPurify.sanitize(markdown.parse(source) as string, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: [
        "p",
        "br",
        "hr",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "ul",
        "ol",
        "li",
        "strong",
        "em",
        "del",
        "blockquote",
        "pre",
        "code",
        "a",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "input",
      ],
      ALLOWED_ATTR: ["href", "title", "start", "align", "type", "checked", "disabled"],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    }),
  );
  for (const input of root.querySelectorAll("input")) {
    input.type = "checkbox";
    input.disabled = true;
  }
  for (const link of root.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    link.removeAttribute("href");
    // Only explicit web/mail links leave the app; protocol-relative URLs,
    // file/data/javascript links and unknown relative paths stay inert.
    if (/^(https?:\/\/|mailto:)/i.test(href) && !hasControlOrSpace(href)) {
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      continue;
    }
    const resolved = links.find((candidate) => candidate.href === href);
    if (resolved?.status === "resolved" && resolved.id) {
      link.href = "#";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        openRecord(resolved.id!);
      });
    } else if (resolved) {
      link.className = "knowledge-unresolved-link";
      link.title = resolved.status === "ambiguous" ? "Ambiguous page link" : "Page unavailable";
      link.setAttribute("aria-disabled", "true");
    }
  }
  for (const table of root.querySelectorAll("table")) {
    const scroll = document.createElement("div");
    scroll.className = "knowledge-markdown-table";
    table.replaceWith(scroll);
    scroll.append(table);
  }
  return root;
}
