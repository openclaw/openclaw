export type ProofPoint = { x: number; y: number };
export type ProofRect = ProofPoint & { width: number; height: number };
export type ProofViewport = { width: number; height: number };
type Label = {
  labelAt?: ProofPoint;
  detail?: string;
  badge?: string;
  /** Agent-selected accent for the captured image, in #RRGGBB form. */
  color?: string;
};
export type ProofAnnotation = Label &
  (
    | { kind: "arrow"; from: ProofPoint; to: ProofPoint; text?: string }
    | { kind: "outline"; rect: ProofRect; text?: string }
    | {
        kind: "alignment";
        axis: "x" | "y";
        edge: "start" | "center" | "end";
        rects: [ProofRect, ProofRect, ...ProofRect[]];
      }
    | { kind: "spacing"; axis: "x" | "y"; from: ProofRect; to: ProofRect; at: number }
  );

function fail(message: string): never {
  throw new Error(`Invalid proof annotations: ${message}`);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("expected an object");
  }
  return value as Record<string, unknown>;
}

function coordinate(value: unknown, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    fail(`coordinate must be finite and between 0 and ${max}`);
  }
  return value;
}

export function validateProofAnnotations(
  input: unknown,
  viewport: ProofViewport,
): asserts input is ProofAnnotation[] {
  if (![viewport.width, viewport.height].every((n) => Number.isInteger(n) && n > 0)) {
    fail("viewport dimensions must be positive integers");
  }
  const point = (value: unknown) => {
    const p = object(value);
    coordinate(p.x, viewport.width);
    coordinate(p.y, viewport.height);
  };
  const rect = (value: unknown) => {
    const r = object(value);
    point(r);
    const w = coordinate(r.width, viewport.width - Number(r.x));
    const h = coordinate(r.height, viewport.height - Number(r.y));
    if (!w || !h) {
      fail("target rectangles must have positive dimensions and fit inside the viewport");
    }
  };
  if (!Array.isArray(input) || !input.length || input.length > 20) {
    fail("provide 1–20 annotations per frame");
  }
  for (const value of input) {
    const a = object(value);
    if (a.labelAt !== undefined) {
      point(a.labelAt);
    }
    for (const [field, limit] of [
      ["detail", 80],
      ["badge", 16],
    ] as const) {
      const text = a[field];
      if (text !== undefined && (typeof text !== "string" || !text.trim() || text.length > limit)) {
        fail(`${field} must contain 1–${limit} characters`);
      }
    }
    if (
      a.color !== undefined &&
      (typeof a.color !== "string" || !/^#[0-9a-f]{6}$/i.test(a.color))
    ) {
      fail("color must be a #RRGGBB accent chosen for the captured image");
    }
    if ((a.kind === "arrow" || a.kind === "outline") && !a.text && (a.detail || a.badge)) {
      fail("a detail or badge needs a text label");
    }
    if (a.kind === "arrow" || a.kind === "outline") {
      if (
        a.text !== undefined &&
        (typeof a.text !== "string" || !a.text.trim() || a.text.length > 80)
      ) {
        fail("labels must contain 1–80 characters");
      }
      if (a.kind === "arrow") {
        point(a.from);
        point(a.to);
        const from = object(a.from),
          to = object(a.to);
        if (from.x === to.x && from.y === to.y) {
          fail("arrow endpoints must differ");
        }
      } else {
        rect(a.rect);
      }
    } else if (a.kind === "alignment" || a.kind === "spacing") {
      if (a.axis !== "x" && a.axis !== "y") {
        fail("measurement axis must be x or y");
      }
      if (a.kind === "alignment") {
        if (!["start", "center", "end"].includes(String(a.edge))) {
          fail("alignment edge must be start, center, or end");
        }
        if (!Array.isArray(a.rects) || a.rects.length < 2 || a.rects.length > 10) {
          fail("alignment needs 2–10 measured rectangles, reference first");
        }
        a.rects.forEach(rect);
      } else {
        rect(a.from);
        rect(a.to);
        if (Number(object(a.from)[a.axis]) > Number(object(a.to)[a.axis])) {
          fail("spacing rectangles must be ordered along the measurement axis");
        }
        coordinate(a.at, a.axis === "x" ? viewport.height : viewport.width);
      }
    } else {
      fail("kind must be arrow, outline, alignment, or spacing");
    }
  }
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
const n = (value: number) => String(Number(value.toFixed(2)));

/** Geometry stays in capture CSS pixels; rasterizers own device scale. */
export function renderProofAnnotations(annotations: ProofAnnotation[], viewport: ProofViewport) {
  const shapes: string[] = [];
  const labels: string[] = [];
  const line = (a: ProofPoint, b: ProofPoint, color: string, dashed = false) => {
    const coords = `x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}"`;
    shapes.push(
      `<line ${coords} stroke="#fff" stroke-width="3" opacity=".8"/><line ${coords} stroke="${color}" stroke-width="1.5" ${dashed ? 'stroke-dasharray="6 5"' : ""}/>`,
    );
  };
  const label = (text: string, at: ProofPoint, color: string, a: Label) => {
    // Chromium lays out the card; reserve conservative bounds without stretching text.
    const width = Math.min(
      viewport.width - 16,
      Math.max(
        text.length * 12,
        (a.detail?.length ?? 0) * 8 + (a.badge ? a.badge.length * 8 + 24 : 0),
      ) + 40,
    );
    const height = a.detail || a.badge ? 90 : 64;
    const x = Math.max(8, Math.min(at.x, viewport.width - width - 8));
    const y = Math.max(8, Math.min(at.y, viewport.height - height - 8));
    const mix = (target: number, amount: number) =>
      "#" +
      [1, 3, 5]
        .map((offset) =>
          Math.round(
            Number.parseInt(color.slice(offset, offset + 2), 16) * (1 - amount) + target * amount,
          )
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
    const secondary =
      a.detail || a.badge
        ? `<div class="proof-detail" style="display:flex;align-items:center;gap:8px;margin-top:10px;color:${mix(0, 0.58)};font-size:14px;line-height:20px">${a.detail ? `<span>${escape(a.detail)}</span>` : ""}${a.badge ? `<span class="proof-badge" style="background:${mix(255, 0.65)};border-radius:999px;padding:2px 8px;font-size:12px;font-weight:650;line-height:16px">${escape(a.badge)}</span>` : ""}</div>`
        : "";
    labels.push(
      `<foreignObject class="proof-label" x="${n(x)}" y="${n(y)}" width="${n(viewport.width - x)}" height="${n(viewport.height - y)}"><div xmlns="http://www.w3.org/1999/xhtml" class="proof-card" style="box-sizing:border-box;width:max-content;white-space:nowrap;padding:18px 20px;border:1px solid ${mix(255, 0.55)};border-radius:18px;background:${mix(255, 0.8)};color:${mix(0, 0.7)};font-family:'DM Sans',sans-serif"><div class="proof-title" style="font-size:20px;font-weight:650;line-height:25px;letter-spacing:-.35px">${escape(text)}</div>${secondary}</div></foreignObject>`,
    );
  };
  const tick = (p: ProofPoint, axis: "x" | "y", color: string) =>
    line(
      { x: p.x - (axis === "y" ? 6 : 0), y: p.y - (axis === "x" ? 6 : 0) },
      { x: p.x + (axis === "y" ? 6 : 0), y: p.y + (axis === "x" ? 6 : 0) },
      color,
    );
  for (const a of annotations) {
    if (a.kind === "arrow") {
      const color = a.color ?? "#e8790c";
      line(a.from, a.to, color);
      const angle = Math.atan2(a.to.y - a.from.y, a.to.x - a.from.x);
      for (const offset of [-0.5, 0.5]) {
        line(
          a.to,
          { x: a.to.x - 8 * Math.cos(angle + offset), y: a.to.y - 8 * Math.sin(angle + offset) },
          color,
        );
      }
      if (a.text) {
        label(a.text, a.labelAt ?? { x: a.from.x, y: a.from.y - 100 }, color, a);
      }
    } else if (a.kind === "outline") {
      const { x, y, width, height } = a.rect;
      const color = a.color ?? "#7c3aed";
      const box = `x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" rx="5" fill="none"`;
      shapes.push(
        `<rect ${box} stroke="#fff" stroke-width="3" opacity=".8"/><rect ${box} stroke="${color}" stroke-width="1.5"/>`,
      );
      if (a.text) {
        label(a.text, a.labelAt ?? { x, y: y - 100 }, color, a);
      }
    } else if (a.kind === "alignment") {
      const vertical = a.axis === "x";
      const size = vertical ? "width" : "height";
      const cross = vertical ? "y" : "x";
      const crossSize = vertical ? "height" : "width";
      const fraction = a.edge === "start" ? 0 : a.edge === "center" ? 0.5 : 1;
      const measuredEdge = (r: ProofRect) => r[a.axis] + r[size] * fraction;
      const edges = a.rects.map(measuredEdge);
      const reference = measuredEdge(a.rects[0]);
      const start = Math.max(4, Math.min(...a.rects.map((r) => r[cross])) - 12);
      const end = Math.min(
        viewport[crossSize] - 4,
        Math.max(...a.rects.map((r) => r[cross] + r[crossSize])) + 12,
      );
      const xy = (edge: number, position: number) =>
        vertical ? { x: edge, y: position } : { x: position, y: edge };
      line(xy(reference, start), xy(reference, end), a.color ?? "#0891b2", true);
      a.rects.forEach((r) => {
        const middle = r[cross] + r[crossSize] / 2;
        const p = xy(measuredEdge(r), middle);
        const delta = measuredEdge(r) - reference;
        const color = a.color ?? (Math.abs(delta) < 0.005 ? "#15803d" : "#e8790c");
        line(xy(reference, middle), p, color);
        tick(p, a.axis, color);
      });
      const maxDelta = Math.max(...edges.map((edge) => Math.abs(edge - reference)));
      label(
        `Max Δ${a.axis} ${n(maxDelta)} px`,
        a.labelAt ?? xy(reference + 16, end + 8),
        a.color ?? (maxDelta < 0.005 ? "#15803d" : "#e8790c"),
        a,
      );
    } else {
      const horizontal = a.axis === "x";
      const size = horizontal ? "width" : "height";
      const farEdge = a.from[a.axis] + a.from[size];
      const end = a.to[a.axis];
      const gap = end - farEdge;
      const start = gap < 0 ? Math.min(farEdge, a.to[a.axis] + a.to[size]) : farEdge;
      const p = horizontal ? { x: start, y: a.at } : { x: a.at, y: start };
      const q = horizontal ? { x: end, y: a.at } : { x: a.at, y: end };
      const color = a.color ?? (gap < 0 ? "#e8790c" : "#0891b2");
      line(p, q, color);
      tick(p, a.axis, color);
      tick(q, a.axis, color);
      label(
        `${gap < 0 ? "Overlap" : "Gap"} ${n(Math.abs(end - start))} px`,
        a.labelAt ?? { x: (p.x + q.x) / 2 + 12, y: (p.y + q.y) / 2 + 12 },
        color,
        a,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}" fill="none" stroke-linecap="round" stroke-linejoin="round">${shapes.join("")}${labels.join("")}</svg>`;
}
