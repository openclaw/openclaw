import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { n as mutateConfigFile } from "./mutate-DLC8bveh.js";
import "./config-mutation-C9bUHI1l.js";
import "./runtime-config-snapshot-BBsNBtE3.js";
import { t as FILE_TRANSFER_NODE_INVOKE_COMMANDS } from "./node-invoke-policy-commands-DfRVjRLi.js";
import { t as appendFileTransferAudit } from "./audit-BUOi65Ul.js";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
//#region node_modules/balanced-match/dist/esm/index.js
const balanced = (a, b, str) => {
	const ma = a instanceof RegExp ? maybeMatch(a, str) : a;
	const mb = b instanceof RegExp ? maybeMatch(b, str) : b;
	const r = ma !== null && mb != null && range(ma, mb, str);
	return r && {
		start: r[0],
		end: r[1],
		pre: str.slice(0, r[0]),
		body: str.slice(r[0] + ma.length, r[1]),
		post: str.slice(r[1] + mb.length)
	};
};
const maybeMatch = (reg, str) => {
	const m = str.match(reg);
	return m ? m[0] : null;
};
const range = (a, b, str) => {
	let begs, beg, left, right = void 0, result;
	let ai = str.indexOf(a);
	let bi = str.indexOf(b, ai + 1);
	let i = ai;
	if (ai >= 0 && bi > 0) {
		if (a === b) return [ai, bi];
		begs = [];
		left = str.length;
		while (i >= 0 && !result) {
			if (i === ai) {
				begs.push(i);
				ai = str.indexOf(a, i + 1);
			} else if (begs.length === 1) {
				const r = begs.pop();
				if (r !== void 0) result = [r, bi];
			} else {
				beg = begs.pop();
				if (beg !== void 0 && beg < left) {
					left = beg;
					right = bi;
				}
				bi = str.indexOf(b, i + 1);
			}
			i = ai < bi && ai >= 0 ? ai : bi;
		}
		if (begs.length && right !== void 0) result = [left, right];
	}
	return result;
};
//#endregion
//#region node_modules/brace-expansion/dist/esm/index.js
const escSlash = "\0SLASH" + Math.random() + "\0";
const escOpen = "\0OPEN" + Math.random() + "\0";
const escClose = "\0CLOSE" + Math.random() + "\0";
const escComma = "\0COMMA" + Math.random() + "\0";
const escPeriod = "\0PERIOD" + Math.random() + "\0";
const escSlashPattern = new RegExp(escSlash, "g");
const escOpenPattern = new RegExp(escOpen, "g");
const escClosePattern = new RegExp(escClose, "g");
const escCommaPattern = new RegExp(escComma, "g");
const escPeriodPattern = new RegExp(escPeriod, "g");
const slashPattern = /\\\\/g;
const openPattern = /\\{/g;
const closePattern = /\\}/g;
const commaPattern = /\\,/g;
const periodPattern = /\\\./g;
const EXPANSION_MAX = 1e5;
function numeric(str) {
	return !isNaN(str) ? parseInt(str, 10) : str.charCodeAt(0);
}
function escapeBraces(str) {
	return str.replace(slashPattern, escSlash).replace(openPattern, escOpen).replace(closePattern, escClose).replace(commaPattern, escComma).replace(periodPattern, escPeriod);
}
function unescapeBraces(str) {
	return str.replace(escSlashPattern, "\\").replace(escOpenPattern, "{").replace(escClosePattern, "}").replace(escCommaPattern, ",").replace(escPeriodPattern, ".");
}
/**
* Basically just str.split(","), but handling cases
* where we have nested braced sections, which should be
* treated as individual members, like {a,{b,c},d}
*/
function parseCommaParts(str) {
	if (!str) return [""];
	const parts = [];
	const m = balanced("{", "}", str);
	if (!m) return str.split(",");
	const { pre, body, post } = m;
	const p = pre.split(",");
	p[p.length - 1] += "{" + body + "}";
	const postParts = parseCommaParts(post);
	if (post.length) {
		p[p.length - 1] += postParts.shift();
		p.push.apply(p, postParts);
	}
	parts.push.apply(parts, p);
	return parts;
}
function expand(str, options = {}) {
	if (!str) return [];
	const { max = EXPANSION_MAX } = options;
	if (str.slice(0, 2) === "{}") str = "\\{\\}" + str.slice(2);
	return expand_(escapeBraces(str), max, true).map(unescapeBraces);
}
function embrace(str) {
	return "{" + str + "}";
}
function isPadded(el) {
	return /^-?0\d/.test(el);
}
function lte(i, y) {
	return i <= y;
}
function gte(i, y) {
	return i >= y;
}
function expand_(str, max, isTop) {
	/** @type {string[]} */
	const expansions = [];
	const m = balanced("{", "}", str);
	if (!m) return [str];
	const pre = m.pre;
	const post = m.post.length ? expand_(m.post, max, false) : [""];
	if (/\$$/.test(m.pre)) for (let k = 0; k < post.length && k < max; k++) {
		const expansion = pre + "{" + m.body + "}" + post[k];
		expansions.push(expansion);
	}
	else {
		const isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m.body);
		const isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m.body);
		const isSequence = isNumericSequence || isAlphaSequence;
		const isOptions = m.body.indexOf(",") >= 0;
		if (!isSequence && !isOptions) {
			if (m.post.match(/,(?!,).*\}/)) {
				str = m.pre + "{" + m.body + escClose + m.post;
				return expand_(str, max, true);
			}
			return [str];
		}
		let n;
		if (isSequence) n = m.body.split(/\.\./);
		else {
			n = parseCommaParts(m.body);
			if (n.length === 1 && n[0] !== void 0) {
				n = expand_(n[0], max, false).map(embrace);
				/* c8 ignore start */
				if (n.length === 1) return post.map((p) => m.pre + n[0] + p);
			}
		}
		let N;
		if (isSequence && n[0] !== void 0 && n[1] !== void 0) {
			const x = numeric(n[0]);
			const y = numeric(n[1]);
			const width = Math.max(n[0].length, n[1].length);
			let incr = n.length === 3 && n[2] !== void 0 ? Math.max(Math.abs(numeric(n[2])), 1) : 1;
			let test = lte;
			if (y < x) {
				incr *= -1;
				test = gte;
			}
			const pad = n.some(isPadded);
			N = [];
			for (let i = x; test(i, y) && N.length < max; i += incr) {
				let c;
				if (isAlphaSequence) {
					c = String.fromCharCode(i);
					if (c === "\\") c = "";
				} else {
					c = String(i);
					if (pad) {
						const need = width - c.length;
						if (need > 0) {
							const z = new Array(need + 1).join("0");
							if (i < 0) c = "-" + z + c.slice(1);
							else c = z + c;
						}
					}
				}
				N.push(c);
			}
		} else {
			N = [];
			for (let j = 0; j < n.length; j++) N.push.apply(N, expand_(n[j], max, false));
		}
		for (let j = 0; j < N.length; j++) for (let k = 0; k < post.length && expansions.length < max; k++) {
			const expansion = pre + N[j] + post[k];
			if (!isTop || isSequence || expansion) expansions.push(expansion);
		}
	}
	return expansions;
}
//#endregion
//#region node_modules/minimatch/dist/esm/assert-valid-pattern.js
const MAX_PATTERN_LENGTH = 1024 * 64;
const assertValidPattern = (pattern) => {
	if (typeof pattern !== "string") throw new TypeError("invalid pattern");
	if (pattern.length > MAX_PATTERN_LENGTH) throw new TypeError("pattern is too long");
};
//#endregion
//#region node_modules/minimatch/dist/esm/brace-expressions.js
const posixClasses = {
	"[:alnum:]": ["\\p{L}\\p{Nl}\\p{Nd}", true],
	"[:alpha:]": ["\\p{L}\\p{Nl}", true],
	"[:ascii:]": ["\\x00-\\x7f", false],
	"[:blank:]": ["\\p{Zs}\\t", true],
	"[:cntrl:]": ["\\p{Cc}", true],
	"[:digit:]": ["\\p{Nd}", true],
	"[:graph:]": [
		"\\p{Z}\\p{C}",
		true,
		true
	],
	"[:lower:]": ["\\p{Ll}", true],
	"[:print:]": ["\\p{C}", true],
	"[:punct:]": ["\\p{P}", true],
	"[:space:]": ["\\p{Z}\\t\\r\\n\\v\\f", true],
	"[:upper:]": ["\\p{Lu}", true],
	"[:word:]": ["\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}", true],
	"[:xdigit:]": ["A-Fa-f0-9", false]
};
const braceEscape = (s) => s.replace(/[[\]\\-]/g, "\\$&");
const regexpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
const rangesToString = (ranges) => ranges.join("");
const parseClass = (glob, position) => {
	const pos = position;
	/* c8 ignore start */
	if (glob.charAt(pos) !== "[") throw new Error("not in a brace expression");
	/* c8 ignore stop */
	const ranges = [];
	const negs = [];
	let i = pos + 1;
	let sawStart = false;
	let uflag = false;
	let escaping = false;
	let negate = false;
	let endPos = pos;
	let rangeStart = "";
	WHILE: while (i < glob.length) {
		const c = glob.charAt(i);
		if ((c === "!" || c === "^") && i === pos + 1) {
			negate = true;
			i++;
			continue;
		}
		if (c === "]" && sawStart && !escaping) {
			endPos = i + 1;
			break;
		}
		sawStart = true;
		if (c === "\\") {
			if (!escaping) {
				escaping = true;
				i++;
				continue;
			}
		}
		if (c === "[" && !escaping) {
			for (const [cls, [unip, u, neg]] of Object.entries(posixClasses)) if (glob.startsWith(cls, i)) {
				if (rangeStart) return [
					"$.",
					false,
					glob.length - pos,
					true
				];
				i += cls.length;
				if (neg) negs.push(unip);
				else ranges.push(unip);
				uflag = uflag || u;
				continue WHILE;
			}
		}
		escaping = false;
		if (rangeStart) {
			if (c > rangeStart) ranges.push(braceEscape(rangeStart) + "-" + braceEscape(c));
			else if (c === rangeStart) ranges.push(braceEscape(c));
			rangeStart = "";
			i++;
			continue;
		}
		if (glob.startsWith("-]", i + 1)) {
			ranges.push(braceEscape(c + "-"));
			i += 2;
			continue;
		}
		if (glob.startsWith("-", i + 1)) {
			rangeStart = c;
			i += 2;
			continue;
		}
		ranges.push(braceEscape(c));
		i++;
	}
	if (endPos < i) return [
		"",
		false,
		0,
		false
	];
	if (!ranges.length && !negs.length) return [
		"$.",
		false,
		glob.length - pos,
		true
	];
	if (negs.length === 0 && ranges.length === 1 && /^\\?.$/.test(ranges[0]) && !negate) return [
		regexpEscape(ranges[0].length === 2 ? ranges[0].slice(-1) : ranges[0]),
		false,
		endPos - pos,
		false
	];
	const sranges = "[" + (negate ? "^" : "") + rangesToString(ranges) + "]";
	const snegs = "[" + (negate ? "" : "^") + rangesToString(negs) + "]";
	return [
		ranges.length && negs.length ? "(" + sranges + "|" + snegs + ")" : ranges.length ? sranges : snegs,
		uflag,
		endPos - pos,
		true
	];
};
//#endregion
//#region node_modules/minimatch/dist/esm/unescape.js
/**
* Un-escape a string that has been escaped with {@link escape}.
*
* If the {@link MinimatchOptions.windowsPathsNoEscape} option is used, then
* square-bracket escapes are removed, but not backslash escapes.
*
* For example, it will turn the string `'[*]'` into `*`, but it will not
* turn `'\\*'` into `'*'`, because `\` is a path separator in
* `windowsPathsNoEscape` mode.
*
* When `windowsPathsNoEscape` is not set, then both square-bracket escapes and
* backslash escapes are removed.
*
* Slashes (and backslashes in `windowsPathsNoEscape` mode) cannot be escaped
* or unescaped.
*
* When `magicalBraces` is not set, escapes of braces (`{` and `}`) will not be
* unescaped.
*/
const unescape = (s, { windowsPathsNoEscape = false, magicalBraces = true } = {}) => {
	if (magicalBraces) return windowsPathsNoEscape ? s.replace(/\[([^/\\])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^/\\])\]/g, "$1$2").replace(/\\([^/])/g, "$1");
	return windowsPathsNoEscape ? s.replace(/\[([^/\\{}])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^/\\{}])\]/g, "$1$2").replace(/\\([^/{}])/g, "$1");
};
//#endregion
//#region node_modules/minimatch/dist/esm/ast.js
var _a;
const types = new Set([
	"!",
	"?",
	"+",
	"*",
	"@"
]);
const isExtglobType = (c) => types.has(c);
const isExtglobAST = (c) => isExtglobType(c.type);
const adoptionMap = new Map([
	["!", ["@"]],
	["?", ["?", "@"]],
	["@", ["@"]],
	["*", [
		"*",
		"+",
		"?",
		"@"
	]],
	["+", ["+", "@"]]
]);
const adoptionWithSpaceMap = new Map([
	["!", ["?"]],
	["@", ["?"]],
	["+", ["?", "*"]]
]);
const adoptionAnyMap = new Map([
	["!", ["?", "@"]],
	["?", ["?", "@"]],
	["@", ["?", "@"]],
	["*", [
		"*",
		"+",
		"?",
		"@"
	]],
	["+", [
		"+",
		"@",
		"?",
		"*"
	]]
]);
const usurpMap = new Map([
	["!", new Map([["!", "@"]])],
	["?", new Map([["*", "*"], ["+", "*"]])],
	["@", new Map([
		["!", "!"],
		["?", "?"],
		["@", "@"],
		["*", "*"],
		["+", "+"]
	])],
	["+", new Map([["?", "*"], ["*", "*"]])]
]);
const startNoTraversal = "(?!(?:^|/)\\.\\.?(?:$|/))";
const startNoDot = "(?!\\.)";
const addPatternStart = new Set(["[", "."]);
const justDots = new Set(["..", "."]);
const reSpecials = /* @__PURE__ */ new Set("().*{}+?[]^$\\!");
const regExpEscape$1 = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
const qmark = "[^/]";
const star$1 = "[^/]*?";
const starNoEmpty = "[^/]+?";
let ID = 0;
var AST = class {
	type;
	#root;
	#hasMagic;
	#uflag = false;
	#parts = [];
	#parent;
	#parentIndex;
	#negs;
	#filledNegs = false;
	#options;
	#toString;
	#emptyExt = false;
	id = ++ID;
	get depth() {
		return (this.#parent?.depth ?? -1) + 1;
	}
	[Symbol.for("nodejs.util.inspect.custom")]() {
		return {
			"@@type": "AST",
			id: this.id,
			type: this.type,
			root: this.#root.id,
			parent: this.#parent?.id,
			depth: this.depth,
			partsLength: this.#parts.length,
			parts: this.#parts
		};
	}
	constructor(type, parent, options = {}) {
		this.type = type;
		if (type) this.#hasMagic = true;
		this.#parent = parent;
		this.#root = this.#parent ? this.#parent.#root : this;
		this.#options = this.#root === this ? options : this.#root.#options;
		this.#negs = this.#root === this ? [] : this.#root.#negs;
		if (type === "!" && !this.#root.#filledNegs) this.#negs.push(this);
		this.#parentIndex = this.#parent ? this.#parent.#parts.length : 0;
	}
	get hasMagic() {
		/* c8 ignore start */
		if (this.#hasMagic !== void 0) return this.#hasMagic;
		/* c8 ignore stop */
		for (const p of this.#parts) {
			if (typeof p === "string") continue;
			if (p.type || p.hasMagic) return this.#hasMagic = true;
		}
		return this.#hasMagic;
	}
	toString() {
		return this.#toString !== void 0 ? this.#toString : !this.type ? this.#toString = this.#parts.map((p) => String(p)).join("") : this.#toString = this.type + "(" + this.#parts.map((p) => String(p)).join("|") + ")";
	}
	#fillNegs() {
		/* c8 ignore start */
		if (this !== this.#root) throw new Error("should only call on root");
		if (this.#filledNegs) return this;
		/* c8 ignore stop */
		this.toString();
		this.#filledNegs = true;
		let n;
		while (n = this.#negs.pop()) {
			if (n.type !== "!") continue;
			let p = n;
			let pp = p.#parent;
			while (pp) {
				for (let i = p.#parentIndex + 1; !pp.type && i < pp.#parts.length; i++) for (const part of n.#parts) {
					/* c8 ignore start */
					if (typeof part === "string") throw new Error("string part in extglob AST??");
					/* c8 ignore stop */
					part.copyIn(pp.#parts[i]);
				}
				p = pp;
				pp = p.#parent;
			}
		}
		return this;
	}
	push(...parts) {
		for (const p of parts) {
			if (p === "") continue;
			/* c8 ignore start */
			if (typeof p !== "string" && !(p instanceof _a && p.#parent === this)) throw new Error("invalid part: " + p);
			/* c8 ignore stop */
			this.#parts.push(p);
		}
	}
	toJSON() {
		const ret = this.type === null ? this.#parts.slice().map((p) => typeof p === "string" ? p : p.toJSON()) : [this.type, ...this.#parts.map((p) => p.toJSON())];
		if (this.isStart() && !this.type) ret.unshift([]);
		if (this.isEnd() && (this === this.#root || this.#root.#filledNegs && this.#parent?.type === "!")) ret.push({});
		return ret;
	}
	isStart() {
		if (this.#root === this) return true;
		if (!this.#parent?.isStart()) return false;
		if (this.#parentIndex === 0) return true;
		const p = this.#parent;
		for (let i = 0; i < this.#parentIndex; i++) {
			const pp = p.#parts[i];
			if (!(pp instanceof _a && pp.type === "!")) return false;
		}
		return true;
	}
	isEnd() {
		if (this.#root === this) return true;
		if (this.#parent?.type === "!") return true;
		if (!this.#parent?.isEnd()) return false;
		if (!this.type) return this.#parent?.isEnd();
		/* c8 ignore start */
		const pl = this.#parent ? this.#parent.#parts.length : 0;
		/* c8 ignore stop */
		return this.#parentIndex === pl - 1;
	}
	copyIn(part) {
		if (typeof part === "string") this.push(part);
		else this.push(part.clone(this));
	}
	clone(parent) {
		const c = new _a(this.type, parent);
		for (const p of this.#parts) c.copyIn(p);
		return c;
	}
	static #parseAST(str, ast, pos, opt, extDepth) {
		const maxDepth = opt.maxExtglobRecursion ?? 2;
		let escaping = false;
		let inBrace = false;
		let braceStart = -1;
		let braceNeg = false;
		if (ast.type === null) {
			let i = pos;
			let acc = "";
			while (i < str.length) {
				const c = str.charAt(i++);
				if (escaping || c === "\\") {
					escaping = !escaping;
					acc += c;
					continue;
				}
				if (inBrace) {
					if (i === braceStart + 1) {
						if (c === "^" || c === "!") braceNeg = true;
					} else if (c === "]" && !(i === braceStart + 2 && braceNeg)) inBrace = false;
					acc += c;
					continue;
				} else if (c === "[") {
					inBrace = true;
					braceStart = i;
					braceNeg = false;
					acc += c;
					continue;
				}
				if (!opt.noext && isExtglobType(c) && str.charAt(i) === "(" && extDepth <= maxDepth) {
					ast.push(acc);
					acc = "";
					const ext = new _a(c, ast);
					i = _a.#parseAST(str, ext, i, opt, extDepth + 1);
					ast.push(ext);
					continue;
				}
				acc += c;
			}
			ast.push(acc);
			return i;
		}
		let i = pos + 1;
		let part = new _a(null, ast);
		const parts = [];
		let acc = "";
		while (i < str.length) {
			const c = str.charAt(i++);
			if (escaping || c === "\\") {
				escaping = !escaping;
				acc += c;
				continue;
			}
			if (inBrace) {
				if (i === braceStart + 1) {
					if (c === "^" || c === "!") braceNeg = true;
				} else if (c === "]" && !(i === braceStart + 2 && braceNeg)) inBrace = false;
				acc += c;
				continue;
			} else if (c === "[") {
				inBrace = true;
				braceStart = i;
				braceNeg = false;
				acc += c;
				continue;
			}
			/* c8 ignore stop */
			if (!opt.noext && isExtglobType(c) && str.charAt(i) === "(" && (extDepth <= maxDepth || ast && ast.#canAdoptType(c))) {
				const depthAdd = ast && ast.#canAdoptType(c) ? 0 : 1;
				part.push(acc);
				acc = "";
				const ext = new _a(c, part);
				part.push(ext);
				i = _a.#parseAST(str, ext, i, opt, extDepth + depthAdd);
				continue;
			}
			if (c === "|") {
				part.push(acc);
				acc = "";
				parts.push(part);
				part = new _a(null, ast);
				continue;
			}
			if (c === ")") {
				if (acc === "" && ast.#parts.length === 0) ast.#emptyExt = true;
				part.push(acc);
				acc = "";
				ast.push(...parts, part);
				return i;
			}
			acc += c;
		}
		ast.type = null;
		ast.#hasMagic = void 0;
		ast.#parts = [str.substring(pos - 1)];
		return i;
	}
	#canAdoptWithSpace(child) {
		return this.#canAdopt(child, adoptionWithSpaceMap);
	}
	#canAdopt(child, map = adoptionMap) {
		if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null) return false;
		const gc = child.#parts[0];
		if (!gc || typeof gc !== "object" || gc.type === null) return false;
		return this.#canAdoptType(gc.type, map);
	}
	#canAdoptType(c, map = adoptionAnyMap) {
		return !!map.get(this.type)?.includes(c);
	}
	#adoptWithSpace(child, index) {
		const gc = child.#parts[0];
		const blank = new _a(null, gc, this.options);
		blank.#parts.push("");
		gc.push(blank);
		this.#adopt(child, index);
	}
	#adopt(child, index) {
		const gc = child.#parts[0];
		this.#parts.splice(index, 1, ...gc.#parts);
		for (const p of gc.#parts) if (typeof p === "object") p.#parent = this;
		this.#toString = void 0;
	}
	#canUsurpType(c) {
		return !!usurpMap.get(this.type)?.has(c);
	}
	#canUsurp(child) {
		if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null || this.#parts.length !== 1) return false;
		const gc = child.#parts[0];
		if (!gc || typeof gc !== "object" || gc.type === null) return false;
		return this.#canUsurpType(gc.type);
	}
	#usurp(child) {
		const m = usurpMap.get(this.type);
		const gc = child.#parts[0];
		const nt = m?.get(gc.type);
		/* c8 ignore start - impossible */
		if (!nt) return false;
		/* c8 ignore stop */
		this.#parts = gc.#parts;
		for (const p of this.#parts) if (typeof p === "object") p.#parent = this;
		this.type = nt;
		this.#toString = void 0;
		this.#emptyExt = false;
	}
	static fromGlob(pattern, options = {}) {
		const ast = new _a(null, void 0, options);
		_a.#parseAST(pattern, ast, 0, options, 0);
		return ast;
	}
	toMMPattern() {
		/* c8 ignore start */
		if (this !== this.#root) return this.#root.toMMPattern();
		/* c8 ignore stop */
		const glob = this.toString();
		const [re, body, hasMagic, uflag] = this.toRegExpSource();
		if (!(hasMagic || this.#hasMagic || this.#options.nocase && !this.#options.nocaseMagicOnly && glob.toUpperCase() !== glob.toLowerCase())) return body;
		const flags = (this.#options.nocase ? "i" : "") + (uflag ? "u" : "");
		return Object.assign(new RegExp(`^${re}$`, flags), {
			_src: re,
			_glob: glob
		});
	}
	get options() {
		return this.#options;
	}
	toRegExpSource(allowDot) {
		const dot = allowDot ?? !!this.#options.dot;
		if (this.#root === this) {
			this.#flatten();
			this.#fillNegs();
		}
		if (!isExtglobAST(this)) {
			const noEmpty = this.isStart() && this.isEnd() && !this.#parts.some((s) => typeof s !== "string");
			const src = this.#parts.map((p) => {
				const [re, _, hasMagic, uflag] = typeof p === "string" ? _a.#parseGlob(p, this.#hasMagic, noEmpty) : p.toRegExpSource(allowDot);
				this.#hasMagic = this.#hasMagic || hasMagic;
				this.#uflag = this.#uflag || uflag;
				return re;
			}).join("");
			let start = "";
			if (this.isStart()) {
				if (typeof this.#parts[0] === "string") {
					if (!(this.#parts.length === 1 && justDots.has(this.#parts[0]))) {
						const aps = addPatternStart;
						const needNoTrav = dot && aps.has(src.charAt(0)) || src.startsWith("\\.") && aps.has(src.charAt(2)) || src.startsWith("\\.\\.") && aps.has(src.charAt(4));
						const needNoDot = !dot && !allowDot && aps.has(src.charAt(0));
						start = needNoTrav ? startNoTraversal : needNoDot ? startNoDot : "";
					}
				}
			}
			let end = "";
			if (this.isEnd() && this.#root.#filledNegs && this.#parent?.type === "!") end = "(?:$|\\/)";
			return [
				start + src + end,
				unescape(src),
				this.#hasMagic = !!this.#hasMagic,
				this.#uflag
			];
		}
		const repeated = this.type === "*" || this.type === "+";
		const start = this.type === "!" ? "(?:(?!(?:" : "(?:";
		let body = this.#partsToRegExp(dot);
		if (this.isStart() && this.isEnd() && !body && this.type !== "!") {
			const s = this.toString();
			const me = this;
			me.#parts = [s];
			me.type = null;
			me.#hasMagic = void 0;
			return [
				s,
				unescape(this.toString()),
				false,
				false
			];
		}
		let bodyDotAllowed = !repeated || allowDot || dot || false ? "" : this.#partsToRegExp(true);
		if (bodyDotAllowed === body) bodyDotAllowed = "";
		if (bodyDotAllowed) body = `(?:${body})(?:${bodyDotAllowed})*?`;
		let final = "";
		if (this.type === "!" && this.#emptyExt) final = (this.isStart() && !dot ? startNoDot : "") + starNoEmpty;
		else {
			const close = this.type === "!" ? "))" + (this.isStart() && !dot && !allowDot ? startNoDot : "") + "[^/]*?)" : this.type === "@" ? ")" : this.type === "?" ? ")?" : this.type === "+" && bodyDotAllowed ? ")" : this.type === "*" && bodyDotAllowed ? `)?` : `)${this.type}`;
			final = start + body + close;
		}
		return [
			final,
			unescape(body),
			this.#hasMagic = !!this.#hasMagic,
			this.#uflag
		];
	}
	#flatten() {
		if (!isExtglobAST(this)) {
			for (const p of this.#parts) if (typeof p === "object") p.#flatten();
		} else {
			let iterations = 0;
			let done = false;
			do {
				done = true;
				for (let i = 0; i < this.#parts.length; i++) {
					const c = this.#parts[i];
					if (typeof c === "object") {
						c.#flatten();
						if (this.#canAdopt(c)) {
							done = false;
							this.#adopt(c, i);
						} else if (this.#canAdoptWithSpace(c)) {
							done = false;
							this.#adoptWithSpace(c, i);
						} else if (this.#canUsurp(c)) {
							done = false;
							this.#usurp(c);
						}
					}
				}
			} while (!done && ++iterations < 10);
		}
		this.#toString = void 0;
	}
	#partsToRegExp(dot) {
		return this.#parts.map((p) => {
			/* c8 ignore start */
			if (typeof p === "string") throw new Error("string type in extglob ast??");
			/* c8 ignore stop */
			const [re, _, _hasMagic, uflag] = p.toRegExpSource(dot);
			this.#uflag = this.#uflag || uflag;
			return re;
		}).filter((p) => !(this.isStart() && this.isEnd()) || !!p).join("|");
	}
	static #parseGlob(glob, hasMagic, noEmpty = false) {
		let escaping = false;
		let re = "";
		let uflag = false;
		let inStar = false;
		for (let i = 0; i < glob.length; i++) {
			const c = glob.charAt(i);
			if (escaping) {
				escaping = false;
				re += (reSpecials.has(c) ? "\\" : "") + c;
				continue;
			}
			if (c === "*") {
				if (inStar) continue;
				inStar = true;
				re += noEmpty && /^[*]+$/.test(glob) ? starNoEmpty : star$1;
				hasMagic = true;
				continue;
			} else inStar = false;
			if (c === "\\") {
				if (i === glob.length - 1) re += "\\\\";
				else escaping = true;
				continue;
			}
			if (c === "[") {
				const [src, needUflag, consumed, magic] = parseClass(glob, i);
				if (consumed) {
					re += src;
					uflag = uflag || needUflag;
					i += consumed - 1;
					hasMagic = hasMagic || magic;
					continue;
				}
			}
			if (c === "?") {
				re += qmark;
				hasMagic = true;
				continue;
			}
			re += regExpEscape$1(c);
		}
		return [
			re,
			unescape(glob),
			!!hasMagic,
			uflag
		];
	}
};
_a = AST;
//#endregion
//#region node_modules/minimatch/dist/esm/escape.js
/**
* Escape all magic characters in a glob pattern.
*
* If the {@link MinimatchOptions.windowsPathsNoEscape}
* option is used, then characters are escaped by wrapping in `[]`, because
* a magic character wrapped in a character class can only be satisfied by
* that exact character.  In this mode, `\` is _not_ escaped, because it is
* not interpreted as a magic character, but instead as a path separator.
*
* If the {@link MinimatchOptions.magicalBraces} option is used,
* then braces (`{` and `}`) will be escaped.
*/
const escape = (s, { windowsPathsNoEscape = false, magicalBraces = false } = {}) => {
	if (magicalBraces) return windowsPathsNoEscape ? s.replace(/[?*()[\]{}]/g, "[$&]") : s.replace(/[?*()[\]\\{}]/g, "\\$&");
	return windowsPathsNoEscape ? s.replace(/[?*()[\]]/g, "[$&]") : s.replace(/[?*()[\]\\]/g, "\\$&");
};
//#endregion
//#region node_modules/minimatch/dist/esm/index.js
const minimatch = (p, pattern, options = {}) => {
	assertValidPattern(pattern);
	if (!options.nocomment && pattern.charAt(0) === "#") return false;
	return new Minimatch(pattern, options).match(p);
};
const starDotExtRE = /^\*+([^+@!?*[(]*)$/;
const starDotExtTest = (ext) => (f) => !f.startsWith(".") && f.endsWith(ext);
const starDotExtTestDot = (ext) => (f) => f.endsWith(ext);
const starDotExtTestNocase = (ext) => {
	ext = ext.toLowerCase();
	return (f) => !f.startsWith(".") && f.toLowerCase().endsWith(ext);
};
const starDotExtTestNocaseDot = (ext) => {
	ext = ext.toLowerCase();
	return (f) => f.toLowerCase().endsWith(ext);
};
const starDotStarRE = /^\*+\.\*+$/;
const starDotStarTest = (f) => !f.startsWith(".") && f.includes(".");
const starDotStarTestDot = (f) => f !== "." && f !== ".." && f.includes(".");
const dotStarRE = /^\.\*+$/;
const dotStarTest = (f) => f !== "." && f !== ".." && f.startsWith(".");
const starRE = /^\*+$/;
const starTest = (f) => f.length !== 0 && !f.startsWith(".");
const starTestDot = (f) => f.length !== 0 && f !== "." && f !== "..";
const qmarksRE = /^\?+([^+@!?*[(]*)?$/;
const qmarksTestNocase = ([$0, ext = ""]) => {
	const noext = qmarksTestNoExt([$0]);
	if (!ext) return noext;
	ext = ext.toLowerCase();
	return (f) => noext(f) && f.toLowerCase().endsWith(ext);
};
const qmarksTestNocaseDot = ([$0, ext = ""]) => {
	const noext = qmarksTestNoExtDot([$0]);
	if (!ext) return noext;
	ext = ext.toLowerCase();
	return (f) => noext(f) && f.toLowerCase().endsWith(ext);
};
const qmarksTestDot = ([$0, ext = ""]) => {
	const noext = qmarksTestNoExtDot([$0]);
	return !ext ? noext : (f) => noext(f) && f.endsWith(ext);
};
const qmarksTest = ([$0, ext = ""]) => {
	const noext = qmarksTestNoExt([$0]);
	return !ext ? noext : (f) => noext(f) && f.endsWith(ext);
};
const qmarksTestNoExt = ([$0]) => {
	const len = $0.length;
	return (f) => f.length === len && !f.startsWith(".");
};
const qmarksTestNoExtDot = ([$0]) => {
	const len = $0.length;
	return (f) => f.length === len && f !== "." && f !== "..";
};
/* c8 ignore start */
const defaultPlatform = typeof process === "object" && process ? typeof process.env === "object" && process.env && process.env.__MINIMATCH_TESTING_PLATFORM__ || process.platform : "posix";
const path$1 = {
	win32: { sep: "\\" },
	posix: { sep: "/" }
};
minimatch.sep = defaultPlatform === "win32" ? path$1.win32.sep : path$1.posix.sep;
const GLOBSTAR = Symbol("globstar **");
minimatch.GLOBSTAR = GLOBSTAR;
const star = "[^/]*?";
const twoStarDot = "(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?";
const twoStarNoDot = "(?:(?!(?:\\/|^)\\.).)*?";
const filter = (pattern, options = {}) => (p) => minimatch(p, pattern, options);
minimatch.filter = filter;
const ext = (a, b = {}) => Object.assign({}, a, b);
const defaults = (def) => {
	if (!def || typeof def !== "object" || !Object.keys(def).length) return minimatch;
	const orig = minimatch;
	const m = (p, pattern, options = {}) => orig(p, pattern, ext(def, options));
	return Object.assign(m, {
		Minimatch: class Minimatch extends orig.Minimatch {
			constructor(pattern, options = {}) {
				super(pattern, ext(def, options));
			}
			static defaults(options) {
				return orig.defaults(ext(def, options)).Minimatch;
			}
		},
		AST: class AST extends orig.AST {
			/* c8 ignore start */
			constructor(type, parent, options = {}) {
				super(type, parent, ext(def, options));
			}
			/* c8 ignore stop */
			static fromGlob(pattern, options = {}) {
				return orig.AST.fromGlob(pattern, ext(def, options));
			}
		},
		unescape: (s, options = {}) => orig.unescape(s, ext(def, options)),
		escape: (s, options = {}) => orig.escape(s, ext(def, options)),
		filter: (pattern, options = {}) => orig.filter(pattern, ext(def, options)),
		defaults: (options) => orig.defaults(ext(def, options)),
		makeRe: (pattern, options = {}) => orig.makeRe(pattern, ext(def, options)),
		braceExpand: (pattern, options = {}) => orig.braceExpand(pattern, ext(def, options)),
		match: (list, pattern, options = {}) => orig.match(list, pattern, ext(def, options)),
		sep: orig.sep,
		GLOBSTAR
	});
};
minimatch.defaults = defaults;
const braceExpand = (pattern, options = {}) => {
	assertValidPattern(pattern);
	if (options.nobrace || !/\{(?:(?!\{).)*\}/.test(pattern)) return [pattern];
	return expand(pattern, { max: options.braceExpandMax });
};
minimatch.braceExpand = braceExpand;
const makeRe = (pattern, options = {}) => new Minimatch(pattern, options).makeRe();
minimatch.makeRe = makeRe;
const match = (list, pattern, options = {}) => {
	const mm = new Minimatch(pattern, options);
	list = list.filter((f) => mm.match(f));
	if (mm.options.nonull && !list.length) list.push(pattern);
	return list;
};
minimatch.match = match;
const globMagic = /[?*]|[+@!]\(.*?\)|\[|\]/;
const regExpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var Minimatch = class {
	options;
	set;
	pattern;
	windowsPathsNoEscape;
	nonegate;
	negate;
	comment;
	empty;
	preserveMultipleSlashes;
	partial;
	globSet;
	globParts;
	nocase;
	isWindows;
	platform;
	windowsNoMagicRoot;
	maxGlobstarRecursion;
	regexp;
	constructor(pattern, options = {}) {
		assertValidPattern(pattern);
		options = options || {};
		this.options = options;
		this.maxGlobstarRecursion = options.maxGlobstarRecursion ?? 200;
		this.pattern = pattern;
		this.platform = options.platform || defaultPlatform;
		this.isWindows = this.platform === "win32";
		const awe = "allowWindowsEscape";
		this.windowsPathsNoEscape = !!options.windowsPathsNoEscape || options[awe] === false;
		if (this.windowsPathsNoEscape) this.pattern = this.pattern.replace(/\\/g, "/");
		this.preserveMultipleSlashes = !!options.preserveMultipleSlashes;
		this.regexp = null;
		this.negate = false;
		this.nonegate = !!options.nonegate;
		this.comment = false;
		this.empty = false;
		this.partial = !!options.partial;
		this.nocase = !!this.options.nocase;
		this.windowsNoMagicRoot = options.windowsNoMagicRoot !== void 0 ? options.windowsNoMagicRoot : !!(this.isWindows && this.nocase);
		this.globSet = [];
		this.globParts = [];
		this.set = [];
		this.make();
	}
	hasMagic() {
		if (this.options.magicalBraces && this.set.length > 1) return true;
		for (const pattern of this.set) for (const part of pattern) if (typeof part !== "string") return true;
		return false;
	}
	debug(..._) {}
	make() {
		const pattern = this.pattern;
		const options = this.options;
		if (!options.nocomment && pattern.charAt(0) === "#") {
			this.comment = true;
			return;
		}
		if (!pattern) {
			this.empty = true;
			return;
		}
		this.parseNegate();
		this.globSet = [...new Set(this.braceExpand())];
		if (options.debug) this.debug = (...args) => console.error(...args);
		this.debug(this.pattern, this.globSet);
		const rawGlobParts = this.globSet.map((s) => this.slashSplit(s));
		this.globParts = this.preprocess(rawGlobParts);
		this.debug(this.pattern, this.globParts);
		let set = this.globParts.map((s, _, __) => {
			if (this.isWindows && this.windowsNoMagicRoot) {
				const isUNC = s[0] === "" && s[1] === "" && (s[2] === "?" || !globMagic.test(s[2])) && !globMagic.test(s[3]);
				const isDrive = /^[a-z]:/i.test(s[0]);
				if (isUNC) return [...s.slice(0, 4), ...s.slice(4).map((ss) => this.parse(ss))];
				else if (isDrive) return [s[0], ...s.slice(1).map((ss) => this.parse(ss))];
			}
			return s.map((ss) => this.parse(ss));
		});
		this.debug(this.pattern, set);
		this.set = set.filter((s) => s.indexOf(false) === -1);
		if (this.isWindows) for (let i = 0; i < this.set.length; i++) {
			const p = this.set[i];
			if (p[0] === "" && p[1] === "" && this.globParts[i][2] === "?" && typeof p[3] === "string" && /^[a-z]:$/i.test(p[3])) p[2] = "?";
		}
		this.debug(this.pattern, this.set);
	}
	preprocess(globParts) {
		if (this.options.noglobstar) {
			for (const partset of globParts) for (let j = 0; j < partset.length; j++) if (partset[j] === "**") partset[j] = "*";
		}
		const { optimizationLevel = 1 } = this.options;
		if (optimizationLevel >= 2) {
			globParts = this.firstPhasePreProcess(globParts);
			globParts = this.secondPhasePreProcess(globParts);
		} else if (optimizationLevel >= 1) globParts = this.levelOneOptimize(globParts);
		else globParts = this.adjascentGlobstarOptimize(globParts);
		return globParts;
	}
	adjascentGlobstarOptimize(globParts) {
		return globParts.map((parts) => {
			let gs = -1;
			while (-1 !== (gs = parts.indexOf("**", gs + 1))) {
				let i = gs;
				while (parts[i + 1] === "**") i++;
				if (i !== gs) parts.splice(gs, i - gs);
			}
			return parts;
		});
	}
	levelOneOptimize(globParts) {
		return globParts.map((parts) => {
			parts = parts.reduce((set, part) => {
				const prev = set[set.length - 1];
				if (part === "**" && prev === "**") return set;
				if (part === "..") {
					if (prev && prev !== ".." && prev !== "." && prev !== "**") {
						set.pop();
						return set;
					}
				}
				set.push(part);
				return set;
			}, []);
			return parts.length === 0 ? [""] : parts;
		});
	}
	levelTwoFileOptimize(parts) {
		if (!Array.isArray(parts)) parts = this.slashSplit(parts);
		let didSomething = false;
		do {
			didSomething = false;
			if (!this.preserveMultipleSlashes) {
				for (let i = 1; i < parts.length - 1; i++) {
					const p = parts[i];
					if (i === 1 && p === "" && parts[0] === "") continue;
					if (p === "." || p === "") {
						didSomething = true;
						parts.splice(i, 1);
						i--;
					}
				}
				if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
					didSomething = true;
					parts.pop();
				}
			}
			let dd = 0;
			while (-1 !== (dd = parts.indexOf("..", dd + 1))) {
				const p = parts[dd - 1];
				if (p && p !== "." && p !== ".." && p !== "**" && !(this.isWindows && /^[a-z]:$/i.test(p))) {
					didSomething = true;
					parts.splice(dd - 1, 2);
					dd -= 2;
				}
			}
		} while (didSomething);
		return parts.length === 0 ? [""] : parts;
	}
	firstPhasePreProcess(globParts) {
		let didSomething = false;
		do {
			didSomething = false;
			for (let parts of globParts) {
				let gs = -1;
				while (-1 !== (gs = parts.indexOf("**", gs + 1))) {
					let gss = gs;
					while (parts[gss + 1] === "**") gss++;
					if (gss > gs) parts.splice(gs + 1, gss - gs);
					let next = parts[gs + 1];
					const p = parts[gs + 2];
					const p2 = parts[gs + 3];
					if (next !== "..") continue;
					if (!p || p === "." || p === ".." || !p2 || p2 === "." || p2 === "..") continue;
					didSomething = true;
					parts.splice(gs, 1);
					const other = parts.slice(0);
					other[gs] = "**";
					globParts.push(other);
					gs--;
				}
				if (!this.preserveMultipleSlashes) {
					for (let i = 1; i < parts.length - 1; i++) {
						const p = parts[i];
						if (i === 1 && p === "" && parts[0] === "") continue;
						if (p === "." || p === "") {
							didSomething = true;
							parts.splice(i, 1);
							i--;
						}
					}
					if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
						didSomething = true;
						parts.pop();
					}
				}
				let dd = 0;
				while (-1 !== (dd = parts.indexOf("..", dd + 1))) {
					const p = parts[dd - 1];
					if (p && p !== "." && p !== ".." && p !== "**") {
						didSomething = true;
						const splin = dd === 1 && parts[dd + 1] === "**" ? ["."] : [];
						parts.splice(dd - 1, 2, ...splin);
						if (parts.length === 0) parts.push("");
						dd -= 2;
					}
				}
			}
		} while (didSomething);
		return globParts;
	}
	secondPhasePreProcess(globParts) {
		for (let i = 0; i < globParts.length - 1; i++) for (let j = i + 1; j < globParts.length; j++) {
			const matched = this.partsMatch(globParts[i], globParts[j], !this.preserveMultipleSlashes);
			if (matched) {
				globParts[i] = [];
				globParts[j] = matched;
				break;
			}
		}
		return globParts.filter((gs) => gs.length);
	}
	partsMatch(a, b, emptyGSMatch = false) {
		let ai = 0;
		let bi = 0;
		let result = [];
		let which = "";
		while (ai < a.length && bi < b.length) if (a[ai] === b[bi]) {
			result.push(which === "b" ? b[bi] : a[ai]);
			ai++;
			bi++;
		} else if (emptyGSMatch && a[ai] === "**" && b[bi] === a[ai + 1]) {
			result.push(a[ai]);
			ai++;
		} else if (emptyGSMatch && b[bi] === "**" && a[ai] === b[bi + 1]) {
			result.push(b[bi]);
			bi++;
		} else if (a[ai] === "*" && b[bi] && (this.options.dot || !b[bi].startsWith(".")) && b[bi] !== "**") {
			if (which === "b") return false;
			which = "a";
			result.push(a[ai]);
			ai++;
			bi++;
		} else if (b[bi] === "*" && a[ai] && (this.options.dot || !a[ai].startsWith(".")) && a[ai] !== "**") {
			if (which === "a") return false;
			which = "b";
			result.push(b[bi]);
			ai++;
			bi++;
		} else return false;
		return a.length === b.length && result;
	}
	parseNegate() {
		if (this.nonegate) return;
		const pattern = this.pattern;
		let negate = false;
		let negateOffset = 0;
		for (let i = 0; i < pattern.length && pattern.charAt(i) === "!"; i++) {
			negate = !negate;
			negateOffset++;
		}
		if (negateOffset) this.pattern = pattern.slice(negateOffset);
		this.negate = negate;
	}
	matchOne(file, pattern, partial = false) {
		let fileStartIndex = 0;
		let patternStartIndex = 0;
		if (this.isWindows) {
			const fileDrive = typeof file[0] === "string" && /^[a-z]:$/i.test(file[0]);
			const fileUNC = !fileDrive && file[0] === "" && file[1] === "" && file[2] === "?" && /^[a-z]:$/i.test(file[3]);
			const patternDrive = typeof pattern[0] === "string" && /^[a-z]:$/i.test(pattern[0]);
			const patternUNC = !patternDrive && pattern[0] === "" && pattern[1] === "" && pattern[2] === "?" && typeof pattern[3] === "string" && /^[a-z]:$/i.test(pattern[3]);
			const fdi = fileUNC ? 3 : fileDrive ? 0 : void 0;
			const pdi = patternUNC ? 3 : patternDrive ? 0 : void 0;
			if (typeof fdi === "number" && typeof pdi === "number") {
				const [fd, pd] = [file[fdi], pattern[pdi]];
				if (fd.toLowerCase() === pd.toLowerCase()) {
					pattern[pdi] = fd;
					patternStartIndex = pdi;
					fileStartIndex = fdi;
				}
			}
		}
		const { optimizationLevel = 1 } = this.options;
		if (optimizationLevel >= 2) file = this.levelTwoFileOptimize(file);
		if (pattern.includes(GLOBSTAR)) return this.#matchGlobstar(file, pattern, partial, fileStartIndex, patternStartIndex);
		return this.#matchOne(file, pattern, partial, fileStartIndex, patternStartIndex);
	}
	#matchGlobstar(file, pattern, partial, fileIndex, patternIndex) {
		const firstgs = pattern.indexOf(GLOBSTAR, patternIndex);
		const lastgs = pattern.lastIndexOf(GLOBSTAR);
		const [head, body, tail] = partial ? [
			pattern.slice(patternIndex, firstgs),
			pattern.slice(firstgs + 1),
			[]
		] : [
			pattern.slice(patternIndex, firstgs),
			pattern.slice(firstgs + 1, lastgs),
			pattern.slice(lastgs + 1)
		];
		if (head.length) {
			const fileHead = file.slice(fileIndex, fileIndex + head.length);
			if (!this.#matchOne(fileHead, head, partial, 0, 0)) return false;
			fileIndex += head.length;
			patternIndex += head.length;
		}
		let fileTailMatch = 0;
		if (tail.length) {
			if (tail.length + fileIndex > file.length) return false;
			let tailStart = file.length - tail.length;
			if (this.#matchOne(file, tail, partial, tailStart, 0)) fileTailMatch = tail.length;
			else {
				if (file[file.length - 1] !== "" || fileIndex + tail.length === file.length) return false;
				tailStart--;
				if (!this.#matchOne(file, tail, partial, tailStart, 0)) return false;
				fileTailMatch = tail.length + 1;
			}
		}
		if (!body.length) {
			let sawSome = !!fileTailMatch;
			for (let i = fileIndex; i < file.length - fileTailMatch; i++) {
				const f = String(file[i]);
				sawSome = true;
				if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) return false;
			}
			return partial || sawSome;
		}
		const bodySegments = [[[], 0]];
		let currentBody = bodySegments[0];
		let nonGsParts = 0;
		const nonGsPartsSums = [0];
		for (const b of body) if (b === GLOBSTAR) {
			nonGsPartsSums.push(nonGsParts);
			currentBody = [[], 0];
			bodySegments.push(currentBody);
		} else {
			currentBody[0].push(b);
			nonGsParts++;
		}
		let i = bodySegments.length - 1;
		const fileLength = file.length - fileTailMatch;
		for (const b of bodySegments) b[1] = fileLength - (nonGsPartsSums[i--] + b[0].length);
		return !!this.#matchGlobStarBodySections(file, bodySegments, fileIndex, 0, partial, 0, !!fileTailMatch);
	}
	#matchGlobStarBodySections(file, bodySegments, fileIndex, bodyIndex, partial, globStarDepth, sawTail) {
		const bs = bodySegments[bodyIndex];
		if (!bs) {
			for (let i = fileIndex; i < file.length; i++) {
				sawTail = true;
				const f = file[i];
				if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) return false;
			}
			return sawTail;
		}
		const [body, after] = bs;
		while (fileIndex <= after) {
			if (this.#matchOne(file.slice(0, fileIndex + body.length), body, partial, fileIndex, 0) && globStarDepth < this.maxGlobstarRecursion) {
				const sub = this.#matchGlobStarBodySections(file, bodySegments, fileIndex + body.length, bodyIndex + 1, partial, globStarDepth + 1, sawTail);
				if (sub !== false) return sub;
			}
			const f = file[fileIndex];
			if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) return false;
			fileIndex++;
		}
		return partial || null;
	}
	#matchOne(file, pattern, partial, fileIndex, patternIndex) {
		let fi;
		let pi;
		let pl;
		let fl;
		for (fi = fileIndex, pi = patternIndex, fl = file.length, pl = pattern.length; fi < fl && pi < pl; fi++, pi++) {
			this.debug("matchOne loop");
			let p = pattern[pi];
			let f = file[fi];
			this.debug(pattern, p, f);
			/* c8 ignore start */
			if (p === false || p === GLOBSTAR) return false;
			/* c8 ignore stop */
			let hit;
			if (typeof p === "string") {
				hit = f === p;
				this.debug("string match", p, f, hit);
			} else {
				hit = p.test(f);
				this.debug("pattern match", p, f, hit);
			}
			if (!hit) return false;
		}
		if (fi === fl && pi === pl) return true;
		else if (fi === fl) return partial;
		else if (pi === pl) return fi === fl - 1 && file[fi] === "";
		else throw new Error("wtf?");
		/* c8 ignore stop */
	}
	braceExpand() {
		return braceExpand(this.pattern, this.options);
	}
	parse(pattern) {
		assertValidPattern(pattern);
		const options = this.options;
		if (pattern === "**") return GLOBSTAR;
		if (pattern === "") return "";
		let m;
		let fastTest = null;
		if (m = pattern.match(starRE)) fastTest = options.dot ? starTestDot : starTest;
		else if (m = pattern.match(starDotExtRE)) fastTest = (options.nocase ? options.dot ? starDotExtTestNocaseDot : starDotExtTestNocase : options.dot ? starDotExtTestDot : starDotExtTest)(m[1]);
		else if (m = pattern.match(qmarksRE)) fastTest = (options.nocase ? options.dot ? qmarksTestNocaseDot : qmarksTestNocase : options.dot ? qmarksTestDot : qmarksTest)(m);
		else if (m = pattern.match(starDotStarRE)) fastTest = options.dot ? starDotStarTestDot : starDotStarTest;
		else if (m = pattern.match(dotStarRE)) fastTest = dotStarTest;
		const re = AST.fromGlob(pattern, this.options).toMMPattern();
		if (fastTest && typeof re === "object") Reflect.defineProperty(re, "test", { value: fastTest });
		return re;
	}
	makeRe() {
		if (this.regexp || this.regexp === false) return this.regexp;
		const set = this.set;
		if (!set.length) {
			this.regexp = false;
			return this.regexp;
		}
		const options = this.options;
		const twoStar = options.noglobstar ? star : options.dot ? twoStarDot : twoStarNoDot;
		const flags = new Set(options.nocase ? ["i"] : []);
		let re = set.map((pattern) => {
			const pp = pattern.map((p) => {
				if (p instanceof RegExp) for (const f of p.flags.split("")) flags.add(f);
				return typeof p === "string" ? regExpEscape(p) : p === GLOBSTAR ? GLOBSTAR : p._src;
			});
			pp.forEach((p, i) => {
				const next = pp[i + 1];
				const prev = pp[i - 1];
				if (p !== GLOBSTAR || prev === GLOBSTAR) return;
				if (prev === void 0) if (next !== void 0 && next !== GLOBSTAR) pp[i + 1] = "(?:\\/|" + twoStar + "\\/)?" + next;
				else pp[i] = twoStar;
				else if (next === void 0) pp[i - 1] = prev + "(?:\\/|\\/" + twoStar + ")?";
				else if (next !== GLOBSTAR) {
					pp[i - 1] = prev + "(?:\\/|\\/" + twoStar + "\\/)" + next;
					pp[i + 1] = GLOBSTAR;
				}
			});
			const filtered = pp.filter((p) => p !== GLOBSTAR);
			if (this.partial && filtered.length >= 1) {
				const prefixes = [];
				for (let i = 1; i <= filtered.length; i++) prefixes.push(filtered.slice(0, i).join("/"));
				return "(?:" + prefixes.join("|") + ")";
			}
			return filtered.join("/");
		}).join("|");
		const [open, close] = set.length > 1 ? ["(?:", ")"] : ["", ""];
		re = "^" + open + re + close + "$";
		if (this.partial) re = "^(?:\\/|" + open + re.slice(1, -1) + close + ")$";
		if (this.negate) re = "^(?!" + re + ").+$";
		try {
			this.regexp = new RegExp(re, [...flags].join(""));
		} catch {
			this.regexp = false;
		}
		/* c8 ignore stop */
		return this.regexp;
	}
	slashSplit(p) {
		if (this.preserveMultipleSlashes) return p.split("/");
		else if (this.isWindows && /^\/\/[^/]+/.test(p)) return ["", ...p.split(/\/+/)];
		else return p.split(/\/+/);
	}
	match(f, partial = this.partial) {
		this.debug("match", f, this.pattern);
		if (this.comment) return false;
		if (this.empty) return f === "";
		if (f === "/" && partial) return true;
		const options = this.options;
		if (this.isWindows) f = f.split("\\").join("/");
		const ff = this.slashSplit(f);
		this.debug(this.pattern, "split", ff);
		const set = this.set;
		this.debug(this.pattern, "set", set);
		let filename = ff[ff.length - 1];
		if (!filename) for (let i = ff.length - 2; !filename && i >= 0; i--) filename = ff[i];
		for (const pattern of set) {
			let file = ff;
			if (options.matchBase && pattern.length === 1) file = [filename];
			if (this.matchOne(file, pattern, partial)) {
				if (options.flipNegate) return true;
				return !this.negate;
			}
		}
		if (options.flipNegate) return false;
		return this.negate;
	}
	static defaults(def) {
		return minimatch.defaults(def).Minimatch;
	}
};
/* c8 ignore stop */
minimatch.AST = AST;
minimatch.Minimatch = Minimatch;
minimatch.escape = escape;
minimatch.unescape = unescape;
//#endregion
//#region extensions/file-transfer/src/shared/policy.ts
function asFilePolicyConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function readFilePolicyConfigFromPluginConfig(pluginConfig) {
	if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) return null;
	const nodes = pluginConfig.nodes;
	return asFilePolicyConfig(nodes);
}
function readPluginConfigFromRuntimeConfig() {
	const plugins = getRuntimeConfig().plugins;
	if (!plugins || typeof plugins !== "object") return null;
	const entries = plugins.entries;
	if (!entries || typeof entries !== "object") return null;
	const entry = entries["file-transfer"];
	if (!entry || typeof entry !== "object") return null;
	const pluginConfig = entry.config;
	return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig) ? pluginConfig : null;
}
function readFilePolicyConfig(pluginConfig) {
	return readFilePolicyConfigFromPluginConfig(readPluginConfigFromRuntimeConfig()) ?? readFilePolicyConfigFromPluginConfig(pluginConfig);
}
function expandTilde(p) {
	if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(p === "~" ? 1 : 2));
	return p;
}
function normalizeGlobs(patterns) {
	if (!Array.isArray(patterns)) return [];
	return patterns.filter((p) => typeof p === "string" && p.trim().length > 0).map((p) => expandTilde(p.trim()));
}
function matchesAny(target, patterns) {
	const normalizedTarget = target.replace(/\\/gu, "/");
	for (const pattern of patterns) {
		const normalizedPattern = pattern.replace(/\\/gu, "/");
		if (minimatch(target, pattern, { dot: true }) || minimatch(normalizedTarget, normalizedPattern, { dot: true })) return true;
	}
	return false;
}
function resolveNodePolicy(config, nodeId, nodeDisplayName) {
	const candidates = [nodeId, nodeDisplayName].filter((k) => typeof k === "string" && k.length > 0);
	for (const key of candidates) if (config[key]) return {
		key,
		entry: config[key]
	};
	if (config["*"]) return {
		key: "*",
		entry: config["*"]
	};
	return null;
}
function normalizeAskMode(value) {
	if (value === "on-miss" || value === "always" || value === "off") return value;
	return "off";
}
/**
* Evaluate whether (nodeId, kind, path) is permitted.
*
* Resolution order:
*   1. No file-transfer config or no entry for this node → NO_POLICY (deny,
*      not askable — operator hasn't opted in at all).
*   2. denyPaths matches → POLICY_DENIED, not askable (hard deny).
*   3. ask=always → ask-always (prompt every time).
*   4. allowPaths matches → matched-allow (silent allow).
*   5. ask=on-miss → POLICY_DENIED with askable=true.
*   6. ask=off (or unset) → POLICY_DENIED, not askable.
*/
/**
* Reject any path whose RAW string contains a ".." segment. Checking the
* raw string (not the normalized form) is the point — `posix.normalize`
* collapses "/allowed/../etc/passwd" to "/etc/passwd", which would defeat
* the check. We want to flag the literal traversal sequence the agent
* passed in, before any glob match runs.
*
* Without this, "/allowed/../etc/passwd" matches the glob "/allowed/**"
* pre-realpath, so the node fetches the bytes before the post-flight
* canonical-path check denies — too late, the bytes already crossed the
* node→gateway boundary.
*
* Treats backslash and forward slash as equivalent separators so a Windows
* node can't be hit with "C:\\allowed\\..\\Windows\\system.ini".
*/
function containsParentRefSegment(p) {
	return p.replace(/\\/gu, "/").split("/").includes("..");
}
function evaluateFilePolicy(input) {
	if (containsParentRefSegment(input.path)) return {
		ok: false,
		code: "POLICY_DENIED",
		reason: "path contains '..' segments; reject before glob match",
		askable: false
	};
	const config = readFilePolicyConfig(input.pluginConfig);
	if (!config) return {
		ok: false,
		code: "NO_POLICY",
		reason: "no plugins.entries.file-transfer.config.nodes config; file-transfer is deny-by-default until configured",
		askable: false
	};
	const resolved = resolveNodePolicy(config, input.nodeId, input.nodeDisplayName);
	if (!resolved) return {
		ok: false,
		code: "NO_POLICY",
		reason: `no file-transfer policy entry for "${input.nodeDisplayName ?? input.nodeId}"; configure plugins.entries.file-transfer.config.nodes or "*"`,
		askable: false
	};
	const nodeConfig = resolved.entry;
	const askMode = normalizeAskMode(nodeConfig.ask);
	const maxBytes = typeof nodeConfig.maxBytes === "number" && Number.isFinite(nodeConfig.maxBytes) ? Math.max(1, Math.floor(nodeConfig.maxBytes)) : void 0;
	const followSymlinks = nodeConfig.followSymlinks === true;
	const denyPatterns = normalizeGlobs(nodeConfig.denyPaths);
	if (matchesAny(input.path, denyPatterns)) return {
		ok: false,
		code: "POLICY_DENIED",
		reason: "path matches a denyPaths pattern",
		askable: false,
		askMode,
		maxBytes,
		followSymlinks
	};
	if (askMode === "always") return {
		ok: true,
		reason: "ask-always",
		askMode,
		maxBytes,
		followSymlinks
	};
	const allowPatterns = input.kind === "read" ? normalizeGlobs(nodeConfig.allowReadPaths) : normalizeGlobs(nodeConfig.allowWritePaths);
	if (allowPatterns.length > 0 && matchesAny(input.path, allowPatterns)) return {
		ok: true,
		reason: "matched-allow",
		maxBytes,
		followSymlinks
	};
	if (askMode === "on-miss") return {
		ok: false,
		code: "POLICY_DENIED",
		reason: `path does not match any allow${input.kind === "read" ? "Read" : "Write"}Paths pattern`,
		askable: true,
		askMode,
		maxBytes,
		followSymlinks
	};
	return {
		ok: false,
		code: "POLICY_DENIED",
		reason: allowPatterns.length === 0 ? `no allow${input.kind === "read" ? "Read" : "Write"}Paths configured` : `path does not match any allow${input.kind === "read" ? "Read" : "Write"}Paths pattern`,
		askable: false,
		askMode,
		maxBytes,
		followSymlinks
	};
}
/**
* Persist an "allow-always" approval by appending the path to the
* relevant allowReadPaths / allowWritePaths list for the node. Uses
* mutateConfigFile so the change survives gateway restarts.
*
* Inserts under whichever key matched the policy (per-node entry, or
* the "*" wildcard if that's what was hit). If no entry exists yet,
* creates one keyed by nodeDisplayName ?? nodeId.
*/
/**
* Reject special object keys that would mutate the prototype chain when
* used as a property name (e.g. `__proto__` setter on a plain object).
* The nodeDisplayName comes from paired-node metadata which we don't
* fully control; refuse to persist policy under a key that could corrupt
* the plugin policy container's prototype.
*/
function assertSafeConfigKey(key) {
	if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error(`refusing to persist file-transfer policy under unsafe key: ${key}`);
	return key;
}
async function persistAllowAlways(input) {
	const field = input.kind === "read" ? "allowReadPaths" : "allowWritePaths";
	await mutateConfigFile({
		afterWrite: {
			mode: "none",
			reason: "file-transfer allow-always policy update"
		},
		mutate: (draft) => {
			const root = draft;
			const plugins = root.plugins ??= {};
			const entries = plugins.entries ??= {};
			const pluginEntry = entries["file-transfer"] ??= {};
			const pluginConfig = pluginEntry.config ??= {};
			const fileTransfer = pluginConfig.nodes ??= {};
			let key = [input.nodeId, input.nodeDisplayName].filter((k) => typeof k === "string" && k.length > 0).find((c) => Object.prototype.hasOwnProperty.call(fileTransfer, c));
			if (!key) {
				key = assertSafeConfigKey(input.nodeDisplayName ?? input.nodeId);
				fileTransfer[key] = {};
			}
			const entry = fileTransfer[key];
			const list = Array.isArray(entry[field]) ? entry[field] : [];
			if (!list.includes(input.path)) list.push(input.path);
			entry[field] = list;
		}
	});
}
//#endregion
//#region extensions/file-transfer/src/shared/node-invoke-policy.ts
const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DIR_FETCH_ARCHIVE_LIST_TIMEOUT_MS = 3e4;
const DIR_FETCH_ARCHIVE_LIST_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readPath(params) {
	return typeof params.path === "string" ? params.path.trim() : "";
}
function readMaxBytes(input) {
	const requested = typeof input.value === "number" && Number.isFinite(input.value) ? Math.floor(input.value) : input.defaultValue;
	const clamped = Math.max(1, Math.min(requested, input.hardMax));
	return input.policyMax ? Math.min(clamped, input.policyMax) : clamped;
}
function commandKind(command) {
	return command === "file.write" ? "write" : "read";
}
function promptVerb(command) {
	switch (command) {
		case "dir.fetch": return "Fetch directory";
		case "dir.list": return "List directory";
		case "file.write": return "Write file";
		case "file.fetch": return "Read file";
	}
	return command;
}
async function requestApproval(input) {
	const nodeDisplayName = input.ctx.node?.displayName;
	const decision = evaluateFilePolicy({
		nodeId: input.ctx.nodeId,
		nodeDisplayName,
		kind: input.kind,
		path: input.path,
		pluginConfig: input.ctx.pluginConfig
	});
	if (decision.ok && decision.reason === "matched-allow") return {
		ok: true,
		followSymlinks: decision.followSymlinks,
		maxBytes: decision.maxBytes
	};
	if (!(decision.ok && decision.reason === "ask-always" || !decision.ok && decision.askable)) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.path,
			decision: !decision.ok && decision.code === "NO_POLICY" ? "denied:no_policy" : "denied:policy",
			errorCode: decision.ok ? void 0 : decision.code,
			reason: decision.ok ? decision.reason : decision.reason,
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: false,
			code: decision.ok ? "POLICY_DENIED" : decision.code,
			message: `${input.op} ${decision.ok ? "POLICY_DENIED" : decision.code}: ${decision.reason}`
		};
	}
	const approvals = input.ctx.approvals;
	if (!approvals) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.path,
			decision: "denied:approval",
			reason: "plugin approvals unavailable",
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: false,
			code: "APPROVAL_UNAVAILABLE",
			message: `${input.op} APPROVAL_UNAVAILABLE: plugin approvals unavailable`
		};
	}
	const verb = promptVerb(input.op);
	const subject = nodeDisplayName ?? input.ctx.nodeId;
	const approval = await approvals.request({
		title: `${verb}: ${input.path}`,
		description: `Allow ${verb.toLowerCase()} on ${subject}\nPath: ${input.path}\nKind: ${input.kind}\n\n"allow-always" appends this exact path to allow${input.kind === "read" ? "Read" : "Write"}Paths.`,
		severity: input.kind === "write" ? "warning" : "info",
		toolName: input.op
	});
	if (approval.decision === "deny" || approval.decision === null || !approval.decision) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.path,
			decision: "denied:approval",
			reason: approval.decision === "deny" ? "operator denied" : "no operator available",
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: false,
			code: approval.decision === "deny" ? "APPROVAL_DENIED" : "APPROVAL_UNAVAILABLE",
			message: approval.decision === "deny" ? `${input.op} APPROVAL_DENIED: operator denied the prompt` : `${input.op} APPROVAL_UNAVAILABLE: no operator client connected to approve the request`
		};
	}
	if (approval.decision === "allow-always") try {
		await persistAllowAlways({
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			kind: input.kind,
			path: input.path
		});
		const refreshed = evaluateFilePolicy({
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			kind: input.kind,
			path: input.path,
			pluginConfig: input.ctx.pluginConfig
		});
		if (refreshed.ok) {
			await appendFileTransferAudit({
				op: input.op,
				nodeId: input.ctx.nodeId,
				nodeDisplayName,
				requestedPath: input.path,
				decision: "allowed:always",
				durationMs: Date.now() - input.startedAt
			});
			return {
				ok: true,
				followSymlinks: refreshed.followSymlinks,
				maxBytes: refreshed.maxBytes
			};
		}
	} catch (error) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.path,
			decision: "allowed:always",
			reason: `persist failed: ${String(error)}`,
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: true,
			followSymlinks: decision.ok ? decision.followSymlinks : false,
			maxBytes: decision.maxBytes
		};
	}
	await appendFileTransferAudit({
		op: input.op,
		nodeId: input.ctx.nodeId,
		nodeDisplayName,
		requestedPath: input.path,
		decision: approval.decision === "allow-always" ? "allowed:always" : "allowed:once",
		durationMs: Date.now() - input.startedAt
	});
	return {
		ok: true,
		followSymlinks: decision.ok ? decision.followSymlinks : false,
		maxBytes: decision.maxBytes
	};
}
function prepareParams(input) {
	const next = {
		...input.params,
		followSymlinks: input.followSymlinks
	};
	delete next.preflightOnly;
	if (input.command === "file.fetch") next.maxBytes = readMaxBytes({
		value: input.params.maxBytes,
		defaultValue: FILE_FETCH_DEFAULT_MAX_BYTES,
		hardMax: FILE_FETCH_HARD_MAX_BYTES,
		policyMax: input.maxBytes
	});
	else if (input.command === "dir.fetch") next.maxBytes = readMaxBytes({
		value: input.params.maxBytes,
		defaultValue: DIR_FETCH_DEFAULT_MAX_BYTES,
		hardMax: DIR_FETCH_HARD_MAX_BYTES,
		policyMax: input.maxBytes
	});
	return next;
}
function readResultPayload(result) {
	return result.payload && typeof result.payload === "object" && !Array.isArray(result.payload) ? result.payload : null;
}
function joinRemotePolicyPath(root, relPath) {
	const rel = relPath.replace(/\\/gu, "/").replace(/^\.\//u, "");
	if (!rel || rel === ".") return root;
	const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
	const prefix = root.replace(/[\\/]$/u, "") || sep;
	return `${prefix}${prefix.endsWith(sep) ? "" : sep}${rel.split("/").join(sep)}`;
}
function validateDirFetchPreflightEntry(entry) {
	if (entry.includes("\0")) return {
		ok: false,
		reason: "entry contains NUL byte"
	};
	const normalized = entry.replace(/\\/gu, "/").replace(/^\.\//u, "");
	if (!normalized || normalized === ".") return {
		ok: false,
		reason: "entry is empty"
	};
	if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return {
		ok: false,
		reason: "entry is absolute"
	};
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return {
		ok: false,
		reason: "entry contains '..' traversal"
	};
	return { ok: true };
}
function normalizeTarEntryPath(entry) {
	const normalized = entry.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
	return normalized.length > 0 ? normalized : null;
}
async function listDirFetchArchiveEntries(payload) {
	const tarBase64 = typeof payload?.tarBase64 === "string" ? payload.tarBase64 : "";
	if (!tarBase64) return {
		ok: false,
		code: "ARCHIVE_ENTRIES_MISSING",
		reason: "dir.fetch archive did not return tarBase64"
	};
	const tarBuffer = Buffer.from(tarBase64, "base64");
	return await new Promise((resolve) => {
		const child = spawn(process.platform !== "win32" ? "/usr/bin/tar" : "tar", ["-tzf", "-"], { stdio: [
			"pipe",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let stderr = "";
		let aborted = false;
		const watchdog = setTimeout(() => {
			aborted = true;
			try {
				child.kill("SIGKILL");
			} catch {}
			resolve({
				ok: false,
				code: "ARCHIVE_ENTRIES_UNREADABLE",
				reason: "tar -tzf timed out"
			});
		}, DIR_FETCH_ARCHIVE_LIST_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.length > DIR_FETCH_ARCHIVE_LIST_MAX_OUTPUT_BYTES) {
				aborted = true;
				clearTimeout(watchdog);
				try {
					child.kill("SIGKILL");
				} catch {}
				resolve({
					ok: false,
					code: "ARCHIVE_ENTRIES_UNREADABLE",
					reason: "tar -tzf output too large"
				});
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			clearTimeout(watchdog);
			if (aborted) return;
			if (code !== 0) {
				resolve({
					ok: false,
					code: "ARCHIVE_ENTRIES_UNREADABLE",
					reason: `tar -tzf exited ${code}: ${stderr.slice(0, 200)}`
				});
				return;
			}
			resolve({
				ok: true,
				entries: stdout.split("\n").map(normalizeTarEntryPath).filter((entry) => entry !== null)
			});
		});
		child.on("error", (error) => {
			clearTimeout(watchdog);
			if (!aborted) resolve({
				ok: false,
				code: "ARCHIVE_ENTRIES_UNREADABLE",
				reason: `tar -tzf error: ${String(error)}`
			});
		});
		child.stdin.end(tarBuffer);
	});
}
async function validateDirFetchEntries(input) {
	const nodeDisplayName = input.ctx.node?.displayName;
	const missingCode = input.phase === "preflight" ? "PREFLIGHT_ENTRIES_MISSING" : "ARCHIVE_ENTRIES_MISSING";
	const invalidCode = input.phase === "preflight" ? "PREFLIGHT_ENTRY_INVALID" : "ARCHIVE_ENTRY_INVALID";
	if (!Array.isArray(input.entries)) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.requestedPath,
			canonicalPath: input.canonicalPath,
			decision: "error",
			errorCode: missingCode,
			reason: `dir.fetch ${input.phase} did not return entries`,
			durationMs: Date.now() - input.startedAt
		});
		return policyDeniedResult({
			op: input.op,
			code: missingCode,
			message: `dir.fetch ${input.phase} did not return entries; refusing archive transfer`,
			details: { path: input.canonicalPath }
		});
	}
	const entries = [];
	for (const entry of input.entries) {
		if (typeof entry !== "string" || entry.length === 0) {
			await appendFileTransferAudit({
				op: input.op,
				nodeId: input.ctx.nodeId,
				nodeDisplayName,
				requestedPath: input.requestedPath,
				canonicalPath: input.canonicalPath,
				decision: "denied:policy",
				errorCode: invalidCode,
				reason: "entry is not a non-empty string",
				durationMs: Date.now() - input.startedAt
			});
			return policyDeniedResult({
				op: input.op,
				code: invalidCode,
				message: `directory ${input.phase} entry is invalid: entry is not a non-empty string`,
				details: {
					path: input.canonicalPath,
					reason: "entry is not a non-empty string"
				}
			});
		}
		const entryValidation = validateDirFetchPreflightEntry(entry);
		if (!entryValidation.ok) {
			const candidate = joinRemotePolicyPath(input.canonicalPath, entry);
			await appendFileTransferAudit({
				op: input.op,
				nodeId: input.ctx.nodeId,
				nodeDisplayName,
				requestedPath: input.requestedPath,
				canonicalPath: candidate,
				decision: "denied:policy",
				errorCode: invalidCode,
				reason: entryValidation.reason,
				durationMs: Date.now() - input.startedAt
			});
			return policyDeniedResult({
				op: input.op,
				code: invalidCode,
				message: `directory ${input.phase} entry ${entry} is invalid: ${entryValidation.reason}`,
				details: {
					path: candidate,
					reason: entryValidation.reason
				}
			});
		}
		entries.push(entry);
	}
	const candidates = [input.canonicalPath, ...entries.map((entry) => joinRemotePolicyPath(input.canonicalPath, entry))];
	for (const candidate of candidates) {
		const policy = evaluateFilePolicy({
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			kind: "read",
			path: candidate,
			pluginConfig: input.ctx.pluginConfig
		});
		if (policy.ok) continue;
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.requestedPath,
			canonicalPath: candidate,
			decision: "denied:policy",
			errorCode: policy.code,
			reason: policy.reason,
			durationMs: Date.now() - input.startedAt
		});
		return policyDeniedResult({
			op: input.op,
			code: "PATH_POLICY_DENIED",
			message: `directory ${input.phase} entry ${candidate} is not allowed by policy: ${policy.reason}`,
			details: {
				path: candidate,
				reason: policy.reason
			}
		});
	}
	return null;
}
function policyDeniedResult(input) {
	return {
		ok: false,
		code: input.code,
		message: `${input.op} ${input.code}: ${input.message}`,
		...input.details ? { details: input.details } : {}
	};
}
async function invokePreflight(input) {
	const nodeDisplayName = input.ctx.node?.displayName;
	const preflight = await input.ctx.invokeNode({ params: {
		...input.params,
		preflightOnly: true
	} });
	if (!preflight.ok) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.requestedPath,
			decision: "error",
			errorCode: preflight.code,
			errorMessage: preflight.message,
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: false,
			result: {
				ok: false,
				code: preflight.code,
				message: `${input.op} failed: ${preflight.message}`,
				details: preflight.details,
				unavailable: true
			}
		};
	}
	const payload = readResultPayload(preflight);
	if (payload?.ok === false) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.requestedPath,
			canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : void 0,
			decision: "error",
			errorCode: typeof payload.code === "string" ? payload.code : void 0,
			errorMessage: typeof payload.message === "string" ? payload.message : void 0,
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: false,
			result: preflight
		};
	}
	return {
		ok: true,
		payload,
		canonicalPath: payload && typeof payload.path === "string" && payload.path ? payload.path : input.requestedPath
	};
}
async function runPathPreflight(input) {
	const preflight = await invokePreflight(input);
	if (!preflight.ok) return preflight.result;
	const nodeDisplayName = input.ctx.node?.displayName;
	const { canonicalPath } = preflight;
	if (canonicalPath === input.requestedPath) return null;
	const policy = evaluateFilePolicy({
		nodeId: input.ctx.nodeId,
		nodeDisplayName,
		kind: input.kind,
		path: canonicalPath,
		pluginConfig: input.ctx.pluginConfig
	});
	if (policy.ok) return null;
	await appendFileTransferAudit({
		op: input.op,
		nodeId: input.ctx.nodeId,
		nodeDisplayName,
		requestedPath: input.requestedPath,
		canonicalPath,
		decision: "denied:symlink_escape",
		errorCode: policy.code,
		reason: policy.reason,
		durationMs: Date.now() - input.startedAt
	});
	return {
		ok: false,
		code: "SYMLINK_TARGET_DENIED",
		message: `${input.op} SYMLINK_TARGET_DENIED: requested path resolved to ${canonicalPath} which is not allowed by policy`
	};
}
async function runDirFetchPreflight(input) {
	const preflight = await invokePreflight(input);
	if (!preflight.ok) return preflight.result;
	return await validateDirFetchEntries({
		ctx: input.ctx,
		op: input.op,
		requestedPath: input.requestedPath,
		canonicalPath: preflight.canonicalPath,
		entries: preflight.payload?.entries,
		startedAt: input.startedAt,
		phase: "preflight"
	});
}
async function handleFileTransferInvoke(ctx) {
	if (!FILE_TRANSFER_NODE_INVOKE_COMMANDS.includes(ctx.command)) return {
		ok: false,
		code: "UNSUPPORTED_COMMAND",
		message: "unsupported file-transfer command"
	};
	const command = ctx.command;
	const op = command;
	const params = asRecord(ctx.params);
	const requestedPath = readPath(params);
	const nodeDisplayName = ctx.node?.displayName;
	const startedAt = Date.now();
	if (!requestedPath) return {
		ok: false,
		code: "INVALID_PARAMS",
		message: `${op} path required`
	};
	const gate = await requestApproval({
		ctx,
		op,
		kind: commandKind(command),
		path: requestedPath,
		startedAt
	});
	if (!gate.ok) return {
		ok: false,
		code: gate.code,
		message: gate.message
	};
	const forwardedParams = prepareParams({
		command,
		params,
		followSymlinks: gate.followSymlinks,
		maxBytes: gate.maxBytes
	});
	if (command === "file.fetch") {
		const preflightDeny = await runPathPreflight({
			ctx,
			op,
			kind: "read",
			params: forwardedParams,
			requestedPath,
			startedAt
		});
		if (preflightDeny) return preflightDeny;
	} else if (command === "file.write") {
		const preflightDeny = await runPathPreflight({
			ctx,
			op,
			kind: "write",
			params: forwardedParams,
			requestedPath,
			startedAt
		});
		if (preflightDeny) return preflightDeny;
	} else if (command === "dir.fetch") {
		const preflightDeny = await runDirFetchPreflight({
			ctx,
			op,
			params: forwardedParams,
			requestedPath,
			startedAt
		});
		if (preflightDeny) return preflightDeny;
	}
	const result = await ctx.invokeNode({ params: forwardedParams });
	if (!result.ok) {
		await appendFileTransferAudit({
			op,
			nodeId: ctx.nodeId,
			nodeDisplayName,
			requestedPath,
			decision: "error",
			errorCode: result.code,
			errorMessage: result.message,
			durationMs: Date.now() - startedAt
		});
		return {
			ok: false,
			code: result.code,
			message: `${op} failed: ${result.message}`,
			details: result.details,
			unavailable: true
		};
	}
	const payload = readResultPayload(result);
	if (payload?.ok === false) {
		await appendFileTransferAudit({
			op,
			nodeId: ctx.nodeId,
			nodeDisplayName,
			requestedPath,
			canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : void 0,
			decision: "error",
			errorCode: typeof payload.code === "string" ? payload.code : void 0,
			errorMessage: typeof payload.message === "string" ? payload.message : void 0,
			durationMs: Date.now() - startedAt
		});
		return result;
	}
	const canonicalPath = payload && typeof payload.path === "string" && payload.path ? payload.path : requestedPath;
	if (canonicalPath !== requestedPath) {
		const postflight = evaluateFilePolicy({
			nodeId: ctx.nodeId,
			nodeDisplayName,
			kind: commandKind(command),
			path: canonicalPath,
			pluginConfig: ctx.pluginConfig
		});
		if (!postflight.ok) {
			await appendFileTransferAudit({
				op,
				nodeId: ctx.nodeId,
				nodeDisplayName,
				requestedPath,
				canonicalPath,
				decision: "denied:symlink_escape",
				errorCode: postflight.code,
				reason: postflight.reason,
				durationMs: Date.now() - startedAt
			});
			return {
				ok: false,
				code: "SYMLINK_TARGET_DENIED",
				message: `${op} SYMLINK_TARGET_DENIED: requested path resolved to ${canonicalPath} which is not allowed by policy`
			};
		}
	}
	if (command === "dir.fetch") {
		const archiveEntries = await listDirFetchArchiveEntries(payload);
		if (!archiveEntries.ok) {
			await appendFileTransferAudit({
				op,
				nodeId: ctx.nodeId,
				nodeDisplayName,
				requestedPath,
				canonicalPath,
				decision: "error",
				errorCode: archiveEntries.code,
				reason: archiveEntries.reason,
				durationMs: Date.now() - startedAt
			});
			return policyDeniedResult({
				op,
				code: archiveEntries.code,
				message: `${archiveEntries.reason}; refusing archive transfer`,
				details: {
					path: canonicalPath,
					reason: archiveEntries.reason
				}
			});
		}
		const archiveDeny = await validateDirFetchEntries({
			ctx,
			op,
			requestedPath,
			canonicalPath,
			entries: archiveEntries.entries,
			startedAt,
			phase: "archive"
		});
		if (archiveDeny) return archiveDeny;
	}
	await appendFileTransferAudit({
		op,
		nodeId: ctx.nodeId,
		nodeDisplayName,
		requestedPath,
		canonicalPath,
		decision: "allowed",
		sizeBytes: typeof payload?.size === "number" ? payload.size : void 0,
		sha256: typeof payload?.sha256 === "string" ? payload.sha256 : void 0,
		durationMs: Date.now() - startedAt
	});
	return result;
}
function createFileTransferNodeInvokePolicy() {
	return {
		commands: [...FILE_TRANSFER_NODE_INVOKE_COMMANDS],
		handle: handleFileTransferInvoke
	};
}
//#endregion
export { createFileTransferNodeInvokePolicy };
