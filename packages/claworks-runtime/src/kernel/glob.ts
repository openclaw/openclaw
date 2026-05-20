/** Minimal glob matcher for event type patterns (`alarm.*`, `workorder.#`). */

export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === value) {
    return true;
  }
  const regex = globToRegExp(pattern);
  return regex.test(value);
}

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      re += ".*";
    } else if (ch === "#") {
      re += "[^.]+";
    } else if (ch === "?") {
      re += ".";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re);
}
