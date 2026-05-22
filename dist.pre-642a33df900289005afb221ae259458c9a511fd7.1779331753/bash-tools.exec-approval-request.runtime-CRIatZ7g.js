import { O as normalizeExecutableToken, a as extractShellWrapperInlineCommand, c as isShellWrapperExecutable, i as extractShellWrapperCommand, t as POSIX_SHELL_WRAPPERS, u as resolveShellWrapperTransportArgv, w as SOURCE_EXECUTABLES } from "./shell-wrapper-resolution-CehhL5X5.js";
import { a as detectInlineEvalArgv, i as detectCommandCarrierArgv, n as detectCarriedShellBuiltinArgv, r as detectCarrierInlineEvalArgv, s as detectShellWrapperThroughCarrierArgv } from "./risks-GkUMojAA.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import * as TreeSitter from "web-tree-sitter";
//#region src/infra/command-explainer/tree-sitter-runtime.ts
const require = createRequire(import.meta.url);
let parserPromise = null;
let parserLoader = loadParser;
const MAX_COMMAND_EXPLANATION_SOURCE_CHARS = 128 * 1024;
const MAX_COMMAND_EXPLANATION_PARSE_MS = 500;
function resolvePackageFileForCommandExplanation(packageName, fileName) {
	let packageEntry;
	try {
		packageEntry = require.resolve(packageName);
	} catch (error) {
		throw new Error(`Unable to resolve ${packageName} while loading the shell command explainer parser`, { cause: error });
	}
	let directory = path.dirname(packageEntry);
	const searched = [];
	for (let depth = 0; depth < 5; depth += 1) {
		const candidate = path.join(directory, fileName);
		searched.push(candidate);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(`Unable to locate ${fileName} in ${packageName} while loading the shell command explainer parser; searched ${searched.join(", ")}`);
}
function resolveWebTreeSitterFile(fileName) {
	return resolvePackageFileForCommandExplanation("web-tree-sitter", fileName);
}
function resolveBashWasmPath() {
	return resolvePackageFileForCommandExplanation("tree-sitter-bash", "tree-sitter-bash.wasm");
}
async function loadParser() {
	await TreeSitter.Parser.init({ locateFile: resolveWebTreeSitterFile });
	const language = await TreeSitter.Language.load(resolveBashWasmPath());
	const parser = new TreeSitter.Parser();
	parser.setLanguage(language);
	return parser;
}
function getBashParserForCommandExplanation() {
	parserPromise ??= parserLoader().catch((error) => {
		parserPromise = null;
		throw error;
	});
	return parserPromise;
}
/**
* Low-level parser access for tests and parser diagnostics.
* Callers own the returned Tree and must call tree.delete().
* Prefer explainShellCommand for normal command-explainer use.
*/
async function parseBashForCommandExplanation(source) {
	if (source.length > MAX_COMMAND_EXPLANATION_SOURCE_CHARS) throw new Error("Shell command is too large to explain");
	const parser = await getBashParserForCommandExplanation();
	const deadlineMs = performance.now() + MAX_COMMAND_EXPLANATION_PARSE_MS;
	let timedOut = false;
	const tree = parser.parse(source, null, { progressCallback: () => {
		timedOut = performance.now() > deadlineMs;
		return timedOut;
	} });
	if (!tree) {
		parser.reset();
		if (timedOut) throw new Error(`tree-sitter-bash timed out after ${MAX_COMMAND_EXPLANATION_PARSE_MS}ms while parsing shell command`);
		throw new Error("tree-sitter-bash returned no parse tree");
	}
	return tree;
}
//#endregion
//#region src/infra/command-explainer/extract.ts
const MAX_WRAPPER_PAYLOAD_DEPTH = 2;
const PARSEABLE_SHELL_WRAPPERS = new Set(POSIX_SHELL_WRAPPERS);
const ROOT_SPAN_BASE = {
	startIndex: 0,
	startPosition: {
		row: 0,
		column: 0
	}
};
function children(node) {
	return Array.from({ length: node.childCount }, (_, index) => node.child(index)).filter((child) => child !== null);
}
function namedChildren(node) {
	return Array.from({ length: node.namedChildCount }, (_, index) => node.namedChild(index)).filter((child) => child !== null);
}
function hasDirectChildType(node, type) {
	return children(node).some((child) => child.type === type);
}
function translatePosition(position, base) {
	return {
		row: base.row + position.row,
		column: position.row === 0 ? base.column + position.column : position.column
	};
}
function translateSpan(span, base) {
	if (base.mapOffset) {
		const start = base.mapOffset(span.startIndex);
		const end = base.mapOffset(span.endIndex);
		return {
			startIndex: start.index,
			endIndex: end.index,
			startPosition: start.position,
			endPosition: end.position
		};
	}
	return {
		startIndex: base.startIndex + span.startIndex,
		endIndex: base.startIndex + span.endIndex,
		startPosition: translatePosition(span.startPosition, base.startPosition),
		endPosition: translatePosition(span.endPosition, base.startPosition)
	};
}
function spanFromNode(node, base = ROOT_SPAN_BASE) {
	return translateSpan({
		startIndex: node.startIndex,
		endIndex: node.endIndex,
		startPosition: {
			row: node.startPosition.row,
			column: node.startPosition.column
		},
		endPosition: {
			row: node.endPosition.row,
			column: node.endPosition.column
		}
	}, base);
}
function advancePosition(position, text) {
	let row = position.row;
	let column = position.column;
	for (let index = 0; index < text.length; index += 1) {
		const ch = text[index];
		if (ch === "\r") {
			if (text[index + 1] === "\n") index += 1;
			row += 1;
			column = 0;
			continue;
		}
		if (ch === "\n") {
			row += 1;
			column = 0;
			continue;
		}
		column += 1;
	}
	return {
		row,
		column
	};
}
function utf8ByteLengthForCodePoint(codePoint) {
	if (codePoint <= 127) return 1;
	if (codePoint <= 2047) return 2;
	if (codePoint <= 65535) return 3;
	return 4;
}
function utf8ByteLength(text) {
	let length = 0;
	for (let index = 0; index < text.length; index += 1) {
		const codePoint = text.codePointAt(index);
		if (codePoint === void 0) continue;
		length += utf8ByteLengthForCodePoint(codePoint);
		if (codePoint > 65535) index += 1;
	}
	return length;
}
function utf8ByteOffsetToStringIndex(text, byteOffset) {
	if (byteOffset <= 0) return 0;
	let currentByteOffset = 0;
	for (let index = 0; index < text.length; index += 1) {
		const codePoint = text.codePointAt(index);
		if (codePoint === void 0) return text.length;
		const codePointLength = utf8ByteLengthForCodePoint(codePoint);
		if (currentByteOffset + codePointLength > byteOffset) return index;
		currentByteOffset += codePointLength;
		if (currentByteOffset === byteOffset) return codePoint > 65535 ? index + 2 : index + 1;
		if (codePoint > 65535) index += 1;
	}
	return text.length;
}
function parserOffsetToStringIndex(source, rootNode) {
	const utf8Length = utf8ByteLength(source);
	if (utf8Length !== source.length && rootNode.endIndex === utf8Length) return (offset) => utf8ByteOffsetToStringIndex(source, offset);
	return (offset) => offset;
}
function spanBaseForParserSource(source, rootNode, base) {
	const offsetToStringIndex = parserOffsetToStringIndex(source, rootNode);
	return {
		startIndex: base.startIndex,
		startPosition: base.startPosition,
		mapOffset(offset) {
			const sourceIndex = offsetToStringIndex(offset);
			if (base.mapOffset) return base.mapOffset(sourceIndex);
			return {
				index: base.startIndex + sourceIndex,
				position: advancePosition(base.startPosition, source.slice(0, sourceIndex))
			};
		}
	};
}
function valuePrefixLength(node) {
	if (node.type === "string" || node.type === "raw_string") return 1;
	if (node.type === "ansi_c_string") return 2;
	return 0;
}
function appendDecodedText(decoded, value, sourceEndOffset) {
	decoded.value += value;
	for (let index = 0; index < value.length; index += 1) decoded.sourceOffsets.push(sourceEndOffset);
}
function identityDecodedShellText(text, sourceOffset = 0) {
	return {
		value: text,
		sourceOffsets: Array.from({ length: text.length + 1 }, (_, index) => sourceOffset + index)
	};
}
function decodedSourceOffsetsForNode(node, value) {
	let decoded;
	switch (node.type) {
		case "raw_string":
			decoded = identityDecodedShellText(node.text.slice(1, -1), 1);
			break;
		case "string":
			decoded = decodeDoubleQuotedTextWithOffsets(node.text);
			break;
		case "ansi_c_string":
			decoded = decodeAnsiCStringWithOffsets(node.text);
			break;
		default:
			decoded = decodeUnquotedShellTextWithOffsets(node.text);
			break;
	}
	if (decoded.value === value && decoded.sourceOffsets.length === value.length + 1) return decoded.sourceOffsets;
	const prefixLength = valuePrefixLength(node);
	return Array.from({ length: value.length + 1 }, (_, index) => prefixLength + index);
}
function argumentFromNode(index, node, value, base) {
	const span = spanFromNode(node, base);
	const decodedSourceOffsets = decodedSourceOffsetsForNode(node, value.value);
	return {
		index,
		text: node.text,
		value: value.value,
		span,
		decodedSourceOffsets
	};
}
const DYNAMIC_WORD_NODE_TYPES = new Set([
	"arithmetic_expansion",
	"command_substitution",
	"expansion",
	"process_substitution",
	"simple_expansion"
]);
const COMMAND_ARGUMENT_NODE_TYPES = new Set([
	"ansi_c_string",
	"arithmetic_expansion",
	"command_substitution",
	"concatenation",
	"expansion",
	"number",
	"process_substitution",
	"raw_string",
	"simple_expansion",
	"string",
	"word"
]);
function hasEscapedLineContinuation(text) {
	return /\\(?:\r\n|[\r\n])/.test(text);
}
function hasExecutableLineContinuation(text) {
	return /^[^\s]*\\(?:\r\n|[\r\n])/.test(text);
}
function hasUnescapedDynamicPattern(text) {
	for (let index = 0; index < text.length; index += 1) {
		const ch = text[index];
		if (ch === "\\") {
			index += 1;
			continue;
		}
		if (ch === "*" || ch === "?") return true;
		if (ch === "[" && text.indexOf("]", index + 1) > index + 1) return true;
		if (ch === "{" && text.indexOf("}", index + 1) > index + 1) return true;
	}
	return false;
}
function decodeUnquotedShellTextWithOffsets(text) {
	const decoded = {
		value: "",
		sourceOffsets: [0]
	};
	for (let index = 0; index < text.length; index += 1) {
		const ch = text[index];
		const next = text[index + 1];
		if (ch === "\\" && next !== void 0) {
			if (next === "\r" && text[index + 2] === "\n") {
				decoded.sourceOffsets[decoded.value.length] = index + 3;
				index += 2;
				continue;
			}
			if (next === "\n" || next === "\r") {
				decoded.sourceOffsets[decoded.value.length] = index + 2;
				index += 1;
				continue;
			}
			appendDecodedText(decoded, next, index + 2);
			index += 1;
			continue;
		}
		appendDecodedText(decoded, ch, index + 1);
	}
	return decoded;
}
function decodeUnquotedShellText(text) {
	return decodeUnquotedShellTextWithOffsets(text).value;
}
function decodeDoubleQuotedTextWithOffsets(text) {
	const hasQuotes = text.startsWith("\"") && text.endsWith("\"");
	const bodyStart = hasQuotes ? 1 : 0;
	const body = hasQuotes ? text.slice(1, -1) : text;
	const decoded = {
		value: "",
		sourceOffsets: [bodyStart]
	};
	for (let index = 0; index < body.length; index += 1) {
		const ch = body[index];
		const next = body[index + 1];
		const sourceOffset = bodyStart + index;
		if (ch === "\\" && next !== void 0) {
			if (next === "\r" && body[index + 2] === "\n") {
				decoded.sourceOffsets[decoded.value.length] = sourceOffset + 3;
				index += 2;
				continue;
			}
			if ([
				"\\",
				"\"",
				"$",
				"`",
				"\n",
				"\r"
			].includes(next)) {
				if (next !== "\n" && next !== "\r") appendDecodedText(decoded, next, sourceOffset + 2);
				else decoded.sourceOffsets[decoded.value.length] = sourceOffset + 2;
				index += 1;
				continue;
			}
		}
		appendDecodedText(decoded, ch, sourceOffset + 1);
	}
	return decoded;
}
function decodeDoubleQuotedText(text) {
	return decodeDoubleQuotedTextWithOffsets(text).value;
}
const ANSI_C_SIMPLE_ESCAPES = {
	"'": "'",
	"\"": "\"",
	"?": "?",
	"\\": "\\",
	a: "\x07",
	b: "\b",
	e: "\x1B",
	E: "\x1B",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "	",
	v: "\v"
};
function decodeAnsiCStringWithOffsets(text) {
	const hasQuotes = text.startsWith("$'") && text.endsWith("'");
	const bodyStart = hasQuotes ? 2 : 0;
	const body = hasQuotes ? text.slice(2, -1) : text;
	const decoded = {
		value: "",
		sourceOffsets: [bodyStart]
	};
	for (let index = 0; index < body.length; index += 1) {
		const ch = body[index];
		const sourceOffset = bodyStart + index;
		if (ch !== "\\") {
			appendDecodedText(decoded, ch, sourceOffset + 1);
			continue;
		}
		const next = body[index + 1];
		if (next === void 0) {
			appendDecodedText(decoded, "\\", sourceOffset + 1);
			continue;
		}
		const simple = ANSI_C_SIMPLE_ESCAPES[next];
		if (simple !== void 0) {
			appendDecodedText(decoded, simple, sourceOffset + 2);
			index += 1;
			continue;
		}
		if (next === "x") {
			const hex = body.slice(index + 2).match(/^[0-9A-Fa-f]{1,2}/)?.[0] ?? "";
			if (hex) {
				appendDecodedText(decoded, String.fromCodePoint(Number.parseInt(hex, 16)), sourceOffset + 2 + hex.length);
				index += 1 + hex.length;
				continue;
			}
		}
		if (next === "u" || next === "U") {
			const maxLength = next === "u" ? 4 : 8;
			const hex = body.slice(index + 2).match(new RegExp(`^[0-9A-Fa-f]{1,${maxLength}}`))?.[0] ?? "";
			if (hex) {
				const codePoint = Number.parseInt(hex, 16);
				try {
					appendDecodedText(decoded, String.fromCodePoint(codePoint), sourceOffset + 2 + hex.length);
				} catch {
					appendDecodedText(decoded, `\\${next}${hex}`, sourceOffset + 2 + hex.length);
				}
				index += 1 + hex.length;
				continue;
			}
		}
		if (/^[0-7]$/.test(next)) {
			const octal = body.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
			if (octal) {
				appendDecodedText(decoded, String.fromCodePoint(Number.parseInt(octal, 8)), sourceOffset + 1 + octal.length);
				index += octal.length;
				continue;
			}
		}
		appendDecodedText(decoded, next, sourceOffset + 2);
		index += 1;
	}
	return decoded;
}
function decodeAnsiCString(text) {
	return decodeAnsiCStringWithOffsets(text).value;
}
function hasDynamicWordPart(node) {
	return DYNAMIC_WORD_NODE_TYPES.has(node.type) || namedChildren(node).some((child) => hasDynamicWordPart(child));
}
function shellWordValue(node) {
	if (DYNAMIC_WORD_NODE_TYPES.has(node.type)) return {
		kind: "dynamic",
		value: node.text
	};
	if (node.type !== "command_name" && node.type !== "concatenation" && namedChildren(node).some((child) => hasDynamicWordPart(child))) return {
		kind: "dynamic",
		value: node.type === "string" ? decodeDoubleQuotedText(node.text) : node.text
	};
	switch (node.type) {
		case "command_name": {
			const parts = namedChildren(node);
			if (parts.length === 0) return hasUnescapedDynamicPattern(node.text) ? {
				kind: "dynamic",
				value: decodeUnquotedShellText(node.text)
			} : {
				kind: "literal",
				value: decodeUnquotedShellText(node.text)
			};
			let value = "";
			for (const part of parts) {
				const partValue = shellWordValue(part);
				value += partValue.value;
				if (partValue.kind !== "literal") return {
					kind: "dynamic",
					value
				};
			}
			return {
				kind: "literal",
				value
			};
		}
		case "word": return hasUnescapedDynamicPattern(node.text) ? {
			kind: "dynamic",
			value: decodeUnquotedShellText(node.text)
		} : {
			kind: "literal",
			value: decodeUnquotedShellText(node.text)
		};
		case "raw_string": return {
			kind: "literal",
			value: node.text.slice(1, -1)
		};
		case "string": return {
			kind: "literal",
			value: decodeDoubleQuotedText(node.text)
		};
		case "ansi_c_string": return {
			kind: "literal",
			value: decodeAnsiCString(node.text)
		};
		case "concatenation": {
			if (hasUnescapedDynamicPattern(node.text)) return {
				kind: "dynamic",
				value: decodeUnquotedShellText(node.text)
			};
			let value = "";
			let dynamic = false;
			for (const child of namedChildren(node)) {
				const childValue = shellWordValue(child);
				value += childValue.value;
				if (childValue.kind !== "literal") dynamic = true;
			}
			return dynamic ? {
				kind: "dynamic",
				value
			} : {
				kind: "literal",
				value
			};
		}
		default: return namedChildren(node).some((child) => shellWordValue(child).kind === "dynamic") ? {
			kind: "dynamic",
			value: decodeUnquotedShellText(node.text)
		} : {
			kind: "literal",
			value: decodeUnquotedShellText(node.text)
		};
	}
}
function commandNameNode(node) {
	return node.childForFieldName("name") ?? namedChildren(node).find((child) => child.type === "command_name") ?? null;
}
function argvFromCommand(node, nameNode, state) {
	if (hasEscapedLineContinuation(nameNode.text) || hasExecutableLineContinuation(node.text)) return null;
	const executable = shellWordValue(nameNode);
	if (executable.kind !== "literal") return null;
	const skipped = new Set([nameNode, ...namedChildren(nameNode)]);
	const argv = [executable.value];
	const argumentsList = [];
	const dynamicArguments = [];
	for (const child of namedChildren(node)) {
		if (skipped.has(child) || child.type === "command_name" || child.type === "variable_assignment" || !COMMAND_ARGUMENT_NODE_TYPES.has(child.type)) continue;
		const value = shellWordValue(child);
		const argument = argumentFromNode(argv.length, child, value, state.spanBase);
		argumentsList.push(argument);
		if (value.kind === "dynamic") dynamicArguments.push({
			index: argument.index,
			text: argument.text,
			value: argument.value,
			span: argument.span
		});
		argv.push(value.value);
	}
	return {
		argv,
		arguments: argumentsList,
		dynamicArguments
	};
}
function firstShellToken(text) {
	return text.trimStart().match(/^\S+/)?.[0] ?? "";
}
function argvFromDeclarationCommand(node, state) {
	const executable = firstShellToken(node.text);
	if (!executable) return null;
	const argv = [executable];
	const argumentsList = [];
	const dynamicArguments = [];
	for (const child of namedChildren(node)) {
		if (!COMMAND_ARGUMENT_NODE_TYPES.has(child.type) && child.type !== "variable_assignment") continue;
		const value = shellWordValue(child);
		const argument = argumentFromNode(argv.length, child, value, state.spanBase);
		argumentsList.push(argument);
		if (value.kind === "dynamic") dynamicArguments.push({
			index: argument.index,
			text: argument.text,
			value: argument.value,
			span: argument.span
		});
		argv.push(value.value);
	}
	return {
		argv,
		arguments: argumentsList,
		dynamicArguments
	};
}
function appendTestCommandArguments(node, argv, argumentsList, dynamicArguments, state) {
	if (node.type === "test_operator" || COMMAND_ARGUMENT_NODE_TYPES.has(node.type)) {
		const value = shellWordValue(node);
		const argument = argumentFromNode(argv.length, node, value, state.spanBase);
		argumentsList.push(argument);
		if (value.kind === "dynamic") dynamicArguments.push({
			index: argument.index,
			text: argument.text,
			value: argument.value,
			span: argument.span
		});
		argv.push(value.value);
		return;
	}
	for (const child of namedChildren(node)) appendTestCommandArguments(child, argv, argumentsList, dynamicArguments, state);
}
function argvFromTestCommand(node, state) {
	const trimmed = node.text.trimStart();
	const executable = trimmed.startsWith("[[") ? "[[" : trimmed.startsWith("[") ? "[" : "";
	if (!executable) return null;
	const argv = [executable];
	const argumentsList = [];
	const dynamicArguments = [];
	for (const child of namedChildren(node)) appendTestCommandArguments(child, argv, argumentsList, dynamicArguments, state);
	return {
		argv,
		arguments: argumentsList,
		dynamicArguments
	};
}
function isCommandLikeNode(node) {
	return node.type === "command" || node.type === "declaration_command" || node.type === "test_command";
}
function recordShape(node, output) {
	if ((node.type === "program" || node.type === "list") && (hasDirectChildType(node, ";") || namedChildren(node).filter(isCommandLikeNode).length > 1)) output.shapes.add("sequence");
	if (hasDirectChildType(node, "&")) output.shapes.add("background");
	if (node.type === "pipeline") output.shapes.add("pipeline");
	if (node.type === "list") {
		if (hasDirectChildType(node, "&&")) output.shapes.add("and");
		if (hasDirectChildType(node, "||")) output.shapes.add("or");
	}
	if (node.type === "if_statement") output.shapes.add("if");
	if (node.type === "for_statement") output.shapes.add("for");
	if (node.type === "while_statement") output.shapes.add("while");
	if (node.type === "case_statement") output.shapes.add("case");
	if (node.type === "subshell") output.shapes.add("subshell");
	if (node.type === "compound_statement") output.shapes.add("group");
}
function shellCommandFlag(argv, startIndex) {
	const shell = normalizeExecutableToken(argv[startIndex - 1] ?? argv[0] ?? "");
	for (let index = startIndex; index < argv.length; index += 1) {
		const token = argv[index]?.trim();
		if (!token) continue;
		if (token === "--") break;
		const lower = token.toLowerCase();
		if (shell === "cmd") {
			if (lower === "/c" || lower === "/k") return {
				flag: token,
				index
			};
			continue;
		}
		if (shell === "powershell" || shell === "pwsh") {
			if (lower === "-c" || lower === "-command" || lower === "--command" || lower === "-encodedcommand" || lower === "-enc" || lower === "-e" || lower === "-f" || lower === "-file") return {
				flag: token,
				index
			};
			continue;
		}
		if (lower === "-c" || lower === "--command") return {
			flag: token,
			index
		};
		if (token.startsWith("-") && !token.startsWith("--") && lower.slice(1).includes("c")) return {
			flag: token,
			index
		};
	}
	return null;
}
function canParseShellWrapperPayload(transportArgv, commandFlag) {
	const shellExecutable = normalizeExecutableToken(transportArgv[0] ?? "");
	if (!PARSEABLE_SHELL_WRAPPERS.has(shellExecutable)) return false;
	const lowerFlag = commandFlag?.toLowerCase() ?? "";
	return lowerFlag === "-c" || lowerFlag === "--command" || /^-[^-]*c[^-]*$/i.test(lowerFlag);
}
function isDynamicPayload(payload, dynamicArguments) {
	return dynamicArguments.some((argument) => argument.value === payload);
}
function payloadBaseFromArgument(argument, payload) {
	const payloadOffset = argument.value.indexOf(payload);
	if (payloadOffset < 0) return null;
	const rawPayloadOffset = argument.decodedSourceOffsets[payloadOffset];
	if (rawPayloadOffset === void 0) return null;
	const prefix = argument.text.slice(0, rawPayloadOffset);
	return {
		startIndex: argument.span.startIndex + rawPayloadOffset,
		startPosition: advancePosition(argument.span.startPosition, prefix),
		mapOffset(offset) {
			const mappedRawOffset = argument.decodedSourceOffsets[payloadOffset + offset] ?? rawPayloadOffset + offset;
			return {
				index: argument.span.startIndex + mappedRawOffset,
				position: advancePosition(argument.span.startPosition, argument.text.slice(0, mappedRawOffset))
			};
		}
	};
}
function payloadBaseFromArguments(payload, argumentsList) {
	const exactArgument = argumentsList.find((argument) => argument.value === payload);
	if (exactArgument) return payloadBaseFromArgument(exactArgument, payload);
	for (const argument of argumentsList) {
		const base = payloadBaseFromArgument(argument, payload);
		if (base) return base;
	}
	return null;
}
function shellWrapperPayloadForParsing(argv, argumentsList, dynamicArguments) {
	const shellWrapper = extractShellWrapperCommand(argv);
	const payload = shellWrapper.command ?? extractShellWrapperInlineCommand(argv);
	if (!shellWrapper.isWrapper || !payload || isDynamicPayload(payload, dynamicArguments)) return null;
	const spanBase = payloadBaseFromArguments(payload, argumentsList);
	if (!spanBase) return null;
	const transportArgv = resolveShellWrapperTransportArgv(argv) ?? argv;
	if (!canParseShellWrapperPayload(transportArgv, (shellCommandFlag(transportArgv, 1) ?? shellCommandFlag(argv, 1))?.flag ?? null)) return null;
	return {
		command: payload,
		spanBase
	};
}
function recordInlineEvalRisk(inlineEval, text, span, output) {
	output.risks.push({
		kind: "inline-eval",
		command: inlineEval.normalizedExecutable,
		flag: inlineEval.flag,
		text,
		span
	});
}
function recordDynamicArgumentRisks(command, dynamicArguments, output) {
	for (const argument of dynamicArguments) output.risks.push({
		kind: "dynamic-argument",
		command,
		argumentIndex: argument.index,
		text: argument.text,
		span: argument.span
	});
}
function recordCommandRisks(argv, dynamicArguments, text, span, output) {
	const executable = argv[0];
	if (!executable) return;
	const normalizedExecutable = normalizeExecutableToken(executable);
	recordDynamicArgumentRisks(normalizedExecutable, dynamicArguments, output);
	const inlineEval = detectInlineEvalArgv(argv) ?? detectCarrierInlineEvalArgv(argv);
	if (inlineEval) recordInlineEvalRisk(inlineEval, text, span, output);
	const shellWrapper = extractShellWrapperCommand(argv);
	const shellWrapperPayload = shellWrapper.command ?? extractShellWrapperInlineCommand(argv);
	if (shellWrapper.isWrapper && shellWrapperPayload) {
		const transportArgv = resolveShellWrapperTransportArgv(argv) ?? argv;
		const shellExecutable = transportArgv[0] ?? executable;
		const commandFlag = shellCommandFlag(transportArgv, 1) ?? shellCommandFlag(argv, 1);
		if (isShellWrapperExecutable(executable)) output.risks.push({
			kind: "shell-wrapper",
			executable: shellExecutable,
			flag: commandFlag?.flag ?? "-c",
			payload: shellWrapperPayload,
			text,
			span
		});
		else output.risks.push({
			kind: "shell-wrapper-through-carrier",
			command: normalizedExecutable,
			text,
			span
		});
	}
	for (const carrier of detectCommandCarrierArgv(argv)) output.risks.push({
		kind: "command-carrier",
		command: carrier.command,
		flag: carrier.flag,
		text,
		span
	});
	if (normalizedExecutable === "eval") output.risks.push({
		kind: "eval",
		text,
		span
	});
	if (SOURCE_EXECUTABLES.has(normalizedExecutable)) output.risks.push({
		kind: "source",
		command: normalizedExecutable,
		text,
		span
	});
	if (normalizedExecutable === "alias") output.risks.push({
		kind: "alias",
		text,
		span
	});
	const carrierShellWrapper = !shellWrapper.isWrapper ? detectShellWrapperThroughCarrierArgv(argv, shellCommandFlag) : null;
	if (carrierShellWrapper) output.risks.push({
		kind: "shell-wrapper-through-carrier",
		command: carrierShellWrapper,
		text,
		span
	});
	const carriedShellBuiltin = detectCarriedShellBuiltinArgv(argv);
	if (carriedShellBuiltin?.kind === "eval") output.risks.push({
		kind: "eval",
		text,
		span
	});
	else if (carriedShellBuiltin?.kind === "source") output.risks.push({
		kind: "source",
		command: carriedShellBuiltin.command,
		text,
		span
	});
}
async function walk(node, output, context, state) {
	recordShape(node, output);
	const span = spanFromNode(node, state.spanBase);
	let childContext = context;
	if (node.type === "program" && hasEscapedLineContinuation(node.text)) output.risks.push({
		kind: "line-continuation",
		text: node.text,
		span
	});
	if (node.type === "function_definition") {
		const nameNode = node.childForFieldName("name");
		output.risks.push({
			kind: "function-definition",
			name: nameNode?.text ?? "",
			text: node.text,
			span
		});
		childContext = "function-definition";
	} else if (node.type === "command_substitution") {
		output.risks.push({
			kind: "command-substitution",
			text: node.text,
			span
		});
		childContext = "command-substitution";
	} else if (node.type === "process_substitution") {
		output.risks.push({
			kind: "process-substitution",
			text: node.text,
			span
		});
		childContext = "process-substitution";
	} else if (node.type === "heredoc_redirect") output.risks.push({
		kind: "heredoc",
		text: node.text,
		span
	});
	else if (node.type === "herestring_redirect") output.risks.push({
		kind: "here-string",
		text: node.text,
		span
	});
	else if (node.type === "file_redirect") output.risks.push({
		kind: "redirect",
		text: node.text,
		span
	});
	else if (node.type === "ERROR") output.risks.push({
		kind: "syntax-error",
		text: node.text,
		span
	});
	if (node.type === "command" || node.type === "declaration_command" || node.type === "test_command") {
		const nameNode = node.type === "command" ? commandNameNode(node) : null;
		const parsed = node.type === "command" ? nameNode ? argvFromCommand(node, nameNode, state) : null : node.type === "declaration_command" ? argvFromDeclarationCommand(node, state) : argvFromTestCommand(node, state);
		if (node.type === "command" && nameNode && !parsed) output.risks.push({
			kind: "dynamic-executable",
			text: nameNode.text,
			span: spanFromNode(nameNode, state.spanBase)
		});
		else if (parsed) {
			const step = {
				context,
				executable: parsed.argv[0] ?? "",
				argv: parsed.argv,
				text: node.text,
				span,
				executableSpan: nameNode !== null ? spanFromNode(nameNode, state.spanBase) : parsed.arguments[0]?.span ?? span
			};
			if (step.executable) {
				output.commands.push(step);
				recordCommandRisks(parsed.argv, parsed.dynamicArguments, node.text, span, output);
				const wrapperPayload = shellWrapperPayloadForParsing(parsed.argv, parsed.arguments, parsed.dynamicArguments);
				if (wrapperPayload && state.wrapperPayloadDepth < MAX_WRAPPER_PAYLOAD_DEPTH) {
					const wrapperTree = await parseBashForCommandExplanation(wrapperPayload.command);
					const wrapperSpanBase = spanBaseForParserSource(wrapperPayload.command, wrapperTree.rootNode, wrapperPayload.spanBase);
					try {
						if (wrapperTree.rootNode.hasError) {
							output.hasParseError = true;
							output.risks.push({
								kind: "syntax-error",
								text: wrapperPayload.command,
								span: spanFromNode(wrapperTree.rootNode, wrapperSpanBase)
							});
						}
						await walk(wrapperTree.rootNode, output, "wrapper-payload", {
							wrapperPayloadDepth: state.wrapperPayloadDepth + 1,
							spanBase: wrapperSpanBase
						});
					} finally {
						wrapperTree.delete();
					}
				}
			}
		}
	}
	for (const child of namedChildren(node)) await walk(child, output, childContext, state);
}
async function explainShellCommand(source) {
	const tree = await parseBashForCommandExplanation(source);
	try {
		const spanBase = spanBaseForParserSource(source, tree.rootNode, ROOT_SPAN_BASE);
		const output = {
			shapes: /* @__PURE__ */ new Set(),
			commands: [],
			risks: [],
			hasParseError: tree.rootNode.hasError
		};
		await walk(tree.rootNode, output, "top-level", {
			wrapperPayloadDepth: 0,
			spanBase
		});
		const topLevelCommands = output.commands.filter((command) => command.context === "top-level");
		return {
			ok: !output.hasParseError,
			source,
			shapes: [...output.shapes],
			topLevelCommands,
			nestedCommands: output.commands.filter((command) => command.context !== "top-level"),
			risks: output.risks
		};
	} finally {
		tree.delete();
	}
}
//#endregion
//#region src/infra/command-explainer/format.ts
const POSIX_COMMAND_HIGHLIGHT_SHELLS = POSIX_SHELL_WRAPPERS;
function spanToCommandSpan(span) {
	if (!Number.isSafeInteger(span.startIndex) || !Number.isSafeInteger(span.endIndex)) return null;
	if (span.startIndex < 0 || span.endIndex <= span.startIndex) return null;
	return {
		startIndex: span.startIndex,
		endIndex: span.endIndex
	};
}
function isUnsupportedShellWrapperArgv(argv) {
	const executable = (resolveShellWrapperTransportArgv([...argv]) ?? argv)[0];
	if (!executable) return false;
	const normalizedExecutable = normalizeExecutableToken(executable);
	return isShellWrapperExecutable(normalizedExecutable) && !POSIX_COMMAND_HIGHLIGHT_SHELLS.has(normalizedExecutable);
}
function hasUnsupportedShellWrapper(explanation) {
	return explanation.topLevelCommands.some((command) => isUnsupportedShellWrapperArgv(command.argv));
}
function formatCommandSpans(explanation) {
	if (hasUnsupportedShellWrapper(explanation)) return [];
	const commandSpans = [];
	for (const command of [...explanation.topLevelCommands, ...explanation.nestedCommands]) {
		const commandSpan = spanToCommandSpan(command.executableSpan);
		if (commandSpan) commandSpans.push(commandSpan);
	}
	return commandSpans;
}
//#endregion
//#region src/agents/bash-tools.exec-approval-request.runtime.ts
async function resolveExecApprovalCommandSpans(command) {
	const commandSpans = formatCommandSpans(await explainShellCommand(command));
	return commandSpans.length > 0 ? commandSpans : void 0;
}
//#endregion
export { resolveExecApprovalCommandSpans };
