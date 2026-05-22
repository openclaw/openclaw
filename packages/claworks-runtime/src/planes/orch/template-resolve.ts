type StepsMap = Record<string, { status?: string; result?: Record<string, unknown> }>;

function parseSlice(spec: string): { start: number; end?: number } {
  const m = spec.match(/^\[:(\d+)\]$/);
  if (m) {
    return { start: 0, end: Number(m[1]) };
  }
  return { start: 0 };
}

/** Resolve `steps['a']['result'].get('b', [])[:5]` style expressions to JS values. */
export function resolveStepsExpression(expr: string, vars: Record<string, unknown>): unknown {
  const trimmed = expr.trim();
  const steps = (vars.steps ?? {}) as StepsMap;

  const match = trimmed.match(
    /^steps\[['"](\w+)['"]\]\[['"]result['"]\]\.get\(\s*['"](\w+)['"]\s*(?:,\s*([^)]+))?\s*\)(.*)$/,
  );
  if (!match) {
    return undefined;
  }

  const stepId = match[1]!;
  const field = match[2]!;
  const fallbackRaw = match[3]?.trim();
  const sliceSpec = match[4]?.trim() ?? "";

  let fallback: unknown = [];
  if (fallbackRaw === "[]") {
    fallback = [];
  } else if (fallbackRaw?.startsWith("'") || fallbackRaw?.startsWith('"')) {
    fallback = fallbackRaw.slice(1, -1);
  } else if (fallbackRaw && fallbackRaw !== "None") {
    fallback = fallbackRaw;
  }

  const result = steps[stepId]?.result ?? {};
  let value: unknown = result[field] ?? fallback;

  if (sliceSpec) {
    const slice = parseSlice(sliceSpec);
    if (Array.isArray(value)) {
      value = value.slice(slice.start, slice.end);
    }
  }

  return value;
}

export function resolveLenExpression(expr: string, vars: Record<string, unknown>): number | null {
  const m = expr.trim().match(/^len\((.+)\)$/);
  if (!m) {
    return null;
  }
  const inner = m[1]!.trim();
  const value = resolveStepsExpression(inner, vars);
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value && typeof value === "object" && "count" in value) {
    return Number((value as { count: unknown }).count);
  }
  return 0;
}

const FOR_LOOP_RE = /\{%\s*for\s+(\w+)\s+in\s+([^%]+?)\s*%}([\s\S]*?)\{%\s*endfor\s*%}/g;

function renderForBody(
  body: string,
  itemVar: string,
  item: Record<string, unknown>,
  index: number,
): string {
  return body
    .replace(/\{\{\s*loop\.index\s*\}\}/g, String(index + 1))
    .replace(
      new RegExp(
        `\\{\\{\\s*${itemVar}\\.get\\(\\s*['"](\\w+)['"]\\s*(?:,\\s*[^)]+)?\\s*\\)\\s*\\}\\}`,
        "g",
      ),
      (_, key) => String(item[key] ?? ""),
    );
}

/** Expand Jinja-style `{% for x in expr %}...{% endfor %}` using step result arrays. */
export function expandJinjaForLoops(template: string, vars: Record<string, unknown>): string {
  return template.replace(FOR_LOOP_RE, (_full, itemVar, listExpr, body) => {
    const items = resolveStepsExpression(String(listExpr), vars);
    if (!Array.isArray(items) || items.length === 0) {
      return "";
    }
    return items
      .map((entry, index) => {
        const item =
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)
            : { value: entry };
        return renderForBody(String(body), String(itemVar), item, index);
      })
      .join("");
  });
}
