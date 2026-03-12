import { Y as displayString, g as visibleWidth } from "./entry.js";

//#region src/terminal/table.ts
function repeat(ch, n) {
	if (n <= 0) return "";
	return ch.repeat(n);
}
function padCell(text, width, align) {
	const w = visibleWidth(text);
	if (w >= width) return text;
	const pad = width - w;
	if (align === "right") return `${repeat(" ", pad)}${text}`;
	if (align === "center") {
		const left = Math.floor(pad / 2);
		const right = pad - left;
		return `${repeat(" ", left)}${text}${repeat(" ", right)}`;
	}
	return `${text}${repeat(" ", pad)}`;
}
function wrapLine(text, width) {
	if (width <= 0) return [text];
	const ESC = "\x1B";
	const tokens = [];
	for (let i = 0; i < text.length;) {
		if (text[i] === ESC) {
			if (text[i + 1] === "[") {
				let j = i + 2;
				while (j < text.length) {
					const ch = text[j];
					if (ch === "m") break;
					if (ch && ch >= "0" && ch <= "9") {
						j += 1;
						continue;
					}
					if (ch === ";") {
						j += 1;
						continue;
					}
					break;
				}
				if (text[j] === "m") {
					tokens.push({
						kind: "ansi",
						value: text.slice(i, j + 1)
					});
					i = j + 1;
					continue;
				}
			}
			if (text[i + 1] === "]" && text.slice(i + 2, i + 5) === "8;;") {
				const st = text.indexOf(`${ESC}\\`, i + 5);
				if (st >= 0) {
					tokens.push({
						kind: "ansi",
						value: text.slice(i, st + 2)
					});
					i = st + 2;
					continue;
				}
			}
		}
		const cp = text.codePointAt(i);
		if (!cp) break;
		const ch = String.fromCodePoint(cp);
		tokens.push({
			kind: "char",
			value: ch
		});
		i += ch.length;
	}
	const firstCharIndex = tokens.findIndex((t) => t.kind === "char");
	if (firstCharIndex < 0) return [text];
	let lastCharIndex = -1;
	for (let i = tokens.length - 1; i >= 0; i -= 1) if (tokens[i]?.kind === "char") {
		lastCharIndex = i;
		break;
	}
	const prefixAnsi = tokens.slice(0, firstCharIndex).filter((t) => t.kind === "ansi").map((t) => t.value).join("");
	const suffixAnsi = tokens.slice(lastCharIndex + 1).filter((t) => t.kind === "ansi").map((t) => t.value).join("");
	const coreTokens = tokens.slice(firstCharIndex, lastCharIndex + 1);
	const lines = [];
	const isBreakChar = (ch) => ch === " " || ch === "	" || ch === "/" || ch === "-" || ch === "_" || ch === ".";
	const isSpaceChar = (ch) => ch === " " || ch === "	";
	let skipNextLf = false;
	const buf = [];
	let bufVisible = 0;
	let lastBreakIndex = null;
	const bufToString = (slice) => (slice ?? buf).map((t) => t.value).join("");
	const bufVisibleWidth = (slice) => slice.reduce((acc, t) => acc + (t.kind === "char" ? 1 : 0), 0);
	const pushLine = (value) => {
		const cleaned = value.replace(/\s+$/, "");
		if (cleaned.trim().length === 0) return;
		lines.push(cleaned);
	};
	const flushAt = (breakAt) => {
		if (buf.length === 0) return;
		if (breakAt == null || breakAt <= 0) {
			pushLine(bufToString());
			buf.length = 0;
			bufVisible = 0;
			lastBreakIndex = null;
			return;
		}
		const left = buf.slice(0, breakAt);
		const rest = buf.slice(breakAt);
		pushLine(bufToString(left));
		while (rest.length > 0 && rest[0]?.kind === "char" && isSpaceChar(rest[0].value)) rest.shift();
		buf.length = 0;
		buf.push(...rest);
		bufVisible = bufVisibleWidth(buf);
		lastBreakIndex = null;
	};
	for (const token of coreTokens) {
		if (token.kind === "ansi") {
			buf.push(token);
			continue;
		}
		const ch = token.value;
		if (skipNextLf) {
			skipNextLf = false;
			if (ch === "\n") continue;
		}
		if (ch === "\n" || ch === "\r") {
			flushAt(buf.length);
			if (ch === "\r") skipNextLf = true;
			continue;
		}
		if (bufVisible + 1 > width && bufVisible > 0) flushAt(lastBreakIndex);
		buf.push(token);
		bufVisible += 1;
		if (isBreakChar(ch)) lastBreakIndex = buf.length;
	}
	flushAt(buf.length);
	if (!lines.length) return [""];
	if (!prefixAnsi && !suffixAnsi) return lines;
	return lines.map((line) => {
		if (!line) return line;
		return `${prefixAnsi}${line}${suffixAnsi}`;
	});
}
function normalizeWidth(n) {
	if (n == null) return;
	if (!Number.isFinite(n) || n <= 0) return;
	return Math.floor(n);
}
function renderTable(opts) {
	const rows = opts.rows.map((row) => {
		const next = {};
		for (const [key, value] of Object.entries(row)) next[key] = displayString(value);
		return next;
	});
	const border = opts.border ?? "unicode";
	if (border === "none") {
		const columns = opts.columns;
		return `${[columns.map((c) => c.header).join(" | "), ...rows.map((r) => columns.map((c) => r[c.key] ?? "").join(" | "))].join("\n")}\n`;
	}
	const padding = Math.max(0, opts.padding ?? 1);
	const columns = opts.columns;
	const metrics = columns.map((c) => {
		return {
			headerW: visibleWidth(c.header),
			cellW: Math.max(0, ...rows.map((r) => visibleWidth(r[c.key] ?? "")))
		};
	});
	const widths = columns.map((c, i) => {
		const m = metrics[i];
		const base = Math.max(m?.headerW ?? 0, m?.cellW ?? 0) + padding * 2;
		const capped = c.maxWidth ? Math.min(base, c.maxWidth) : base;
		return Math.max(c.minWidth ?? 3, capped);
	});
	const maxWidth = normalizeWidth(opts.width);
	const sepCount = columns.length + 1;
	const total = widths.reduce((a, b) => a + b, 0) + sepCount;
	const preferredMinWidths = columns.map((c, i) => Math.max(c.minWidth ?? 3, (metrics[i]?.headerW ?? 0) + padding * 2, 3));
	const absoluteMinWidths = columns.map((_c, i) => Math.max((metrics[i]?.headerW ?? 0) + padding * 2, 3));
	if (maxWidth && total > maxWidth) {
		let over = total - maxWidth;
		const flexOrder = columns.map((_c, i) => ({
			i,
			w: widths[i] ?? 0
		})).filter(({ i }) => Boolean(columns[i]?.flex)).toSorted((a, b) => b.w - a.w).map((x) => x.i);
		const nonFlexOrder = columns.map((_c, i) => ({
			i,
			w: widths[i] ?? 0
		})).filter(({ i }) => !columns[i]?.flex).toSorted((a, b) => b.w - a.w).map((x) => x.i);
		const shrink = (order, minWidths) => {
			while (over > 0) {
				let progressed = false;
				for (const i of order) {
					if ((widths[i] ?? 0) <= (minWidths[i] ?? 0)) continue;
					widths[i] = (widths[i] ?? 0) - 1;
					over -= 1;
					progressed = true;
					if (over <= 0) break;
				}
				if (!progressed) break;
			}
		};
		shrink(flexOrder, preferredMinWidths);
		shrink(flexOrder, absoluteMinWidths);
		shrink(nonFlexOrder, preferredMinWidths);
		shrink(nonFlexOrder, absoluteMinWidths);
	}
	if (maxWidth) {
		const sepCount = columns.length + 1;
		let extra = maxWidth - (widths.reduce((a, b) => a + b, 0) + sepCount);
		if (extra > 0) {
			const flexCols = columns.map((c, i) => ({
				c,
				i
			})).filter(({ c }) => Boolean(c.flex)).map(({ i }) => i);
			if (flexCols.length > 0) {
				const caps = columns.map((c) => typeof c.maxWidth === "number" && c.maxWidth > 0 ? Math.floor(c.maxWidth) : Number.POSITIVE_INFINITY);
				while (extra > 0) {
					let progressed = false;
					for (const i of flexCols) {
						if ((widths[i] ?? 0) >= (caps[i] ?? Number.POSITIVE_INFINITY)) continue;
						widths[i] = (widths[i] ?? 0) + 1;
						extra -= 1;
						progressed = true;
						if (extra <= 0) break;
					}
					if (!progressed) break;
				}
			}
		}
	}
	const box = border === "ascii" ? {
		tl: "+",
		tr: "+",
		bl: "+",
		br: "+",
		h: "-",
		v: "|",
		t: "+",
		ml: "+",
		m: "+",
		mr: "+",
		b: "+"
	} : {
		tl: "┌",
		tr: "┐",
		bl: "└",
		br: "┘",
		h: "─",
		v: "│",
		t: "┬",
		ml: "├",
		m: "┼",
		mr: "┤",
		b: "┴"
	};
	const hLine = (left, mid, right) => `${left}${widths.map((w) => repeat(box.h, w)).join(mid)}${right}`;
	const contentWidthFor = (i) => Math.max(1, widths[i] - padding * 2);
	const padStr = repeat(" ", padding);
	const renderRow = (record, isHeader = false) => {
		const wrapped = columns.map((c) => isHeader ? c.header : record[c.key] ?? "").map((cell, i) => wrapLine(cell, contentWidthFor(i)));
		const height = Math.max(...wrapped.map((w) => w.length));
		const out = [];
		for (let li = 0; li < height; li += 1) {
			const parts = wrapped.map((lines, i) => {
				return `${padStr}${padCell(lines[li] ?? "", contentWidthFor(i), columns[i]?.align ?? "left")}${padStr}`;
			});
			out.push(`${box.v}${parts.join(box.v)}${box.v}`);
		}
		return out;
	};
	const lines = [];
	lines.push(hLine(box.tl, box.t, box.tr));
	lines.push(...renderRow({}, true));
	lines.push(hLine(box.ml, box.m, box.mr));
	for (const row of rows) lines.push(...renderRow(row, false));
	lines.push(hLine(box.bl, box.b, box.br));
	return `${lines.join("\n")}\n`;
}

//#endregion
export { renderTable as t };