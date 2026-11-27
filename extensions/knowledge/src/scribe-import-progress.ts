import { button, el } from "./page-dom.js";
import type { ScribeSnapshot } from "./scribes-state.js";

export function importProgressValue(
  progress: NonNullable<ScribeSnapshot["progress"]>,
  retry: () => void,
): string | HTMLElement {
  if (progress === "unavailable") {
    const value = el("span", "Couldn’t read saved progress", "scribe-status");
    value.append(button("Retry", retry, "knowledge-quiet knowledge-small"));
    return value;
  }
  const { files, done } = progress;
  const noun = files === 1 ? "file" : "files";
  return files
    ? `${done.toLocaleString()} of ${files.toLocaleString()} ${noun} imported`
    : "No files listed yet";
}
