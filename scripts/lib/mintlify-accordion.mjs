// Checks and repairs Mintlify component indentation that can swallow following markdown.
/** Lint message emitted for Mintlify component closing tags with unsafe indentation. */
export const MINTLIFY_ACCORDION_INDENT_MESSAGE =
  "Mintlify component closing tag is indented deeper than its opening tag; Mintlify can parse following markdown as nested content.";

const MINTLIFY_REPAIRED_COMPONENTS = new Set([
  "Accordion",
  "Warning",
  "Note",
  "Tip",
  "ParamField",
  "Steps",
  "Step",
]);

function processMintlifyComponentIndentation(raw, repair) {
  const lines = raw.split(/\r?\n/u);
  const componentStack = [];
  const errors = [];
  let changed = false;
  let fenceMarker = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trimStart();
    const marker = trimmed.match(/^(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fenceMarker) {
        fenceMarker = marker;
      } else if (
        marker[0] === fenceMarker[0] &&
        marker.length >= fenceMarker.length &&
        /^[ \t]*$/u.test(trimmed.slice(marker.length))
      ) {
        fenceMarker = null;
      }
      continue;
    }
    if (fenceMarker) {
      continue;
    }

    const openComponent = line.match(/^(\s*)<([A-Z][A-Za-z0-9]*)\b/u);
    if (openComponent && MINTLIFY_REPAIRED_COMPONENTS.has(openComponent[2])) {
      let indent = openComponent[1].length;
      if (componentStack.length === 0 && openComponent[2] === "ParamField" && indent > 0) {
        if (repair) {
          lines[index] = line.slice(indent);
          changed = true;
        }
        indent = 0;
      }
      componentStack.push({
        indent,
        name: openComponent[2],
      });
      continue;
    }

    const closeComponent = line.match(/^(\s*)<\/([A-Z][A-Za-z0-9]*)>/u);
    if (!closeComponent) {
      continue;
    }

    const opening = MINTLIFY_REPAIRED_COMPONENTS.has(closeComponent[2])
      ? componentStack.pop()
      : undefined;
    if (opening?.name === closeComponent[2] && closeComponent[1].length > opening.indent) {
      errors.push({
        line: index + 1,
        column: closeComponent[1].length + 1,
        message: MINTLIFY_ACCORDION_INDENT_MESSAGE,
      });
      if (repair) {
        lines[index] = `${" ".repeat(opening.indent)}${line.slice(closeComponent[1].length)}`;
        changed = true;
      }
    }
    // Keep spacing repairs inside the same fence boundary as indentation repairs.
    if (repair && /^\s*[-*+]\s+/u.test(lines[index - 1] ?? "")) {
      lines[index] = `\n${lines[index]}`;
      changed = true;
    }
  }

  return { errors, text: changed ? lines.join("\n") : raw };
}

/** Return indentation errors for Mintlify accordion-like components. */
export function checkMintlifyAccordionIndentation(raw) {
  return processMintlifyComponentIndentation(raw, false).errors;
}

/** Repair Mintlify component indentation and list-adjacent closing tags when needed. */
export function repairMintlifyAccordionIndentation(raw) {
  return processMintlifyComponentIndentation(raw, true).text;
}
