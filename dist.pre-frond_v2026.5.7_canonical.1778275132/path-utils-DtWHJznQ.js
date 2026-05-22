import { c as isRecord } from "./utils-D5swhEXt.js";
import "./shared-BUPIPZn8.js";
import { isDeepStrictEqual } from "node:util";
//#region src/secrets/path-utils.ts
function isArrayIndexSegment(segment) {
	return /^\d+$/.test(segment);
}
function expectedContainer(nextSegment) {
	return isArrayIndexSegment(nextSegment) ? "array" : "object";
}
function parseArrayLeafTarget(cursor, leaf, segments) {
	if (!Array.isArray(cursor)) return null;
	if (!isArrayIndexSegment(leaf)) throw new Error(`Invalid array index segment "${leaf}" at ${segments.join(".")}.`);
	return {
		array: cursor,
		index: Number.parseInt(leaf, 10)
	};
}
function traverseToLeafParent(params) {
	if (params.segments.length === 0) throw new Error("Target path is empty.");
	let cursor = params.root;
	for (let index = 0; index < params.segments.length - 1; index += 1) {
		const segment = params.segments[index] ?? "";
		if (Array.isArray(cursor)) {
			if (!isArrayIndexSegment(segment)) throw new Error(`Invalid array index segment "${segment}" at ${params.segments.join(".")}.`);
			const arrayIndex = Number.parseInt(segment, 10);
			if (params.requireExistingSegment && (arrayIndex < 0 || arrayIndex >= cursor.length)) throw new Error(`Path segment does not exist at ${params.segments.slice(0, index + 1).join(".")}.`);
			cursor = cursor[arrayIndex];
			continue;
		}
		if (!isRecord(cursor)) throw new Error(`Invalid path shape at ${params.segments.slice(0, index).join(".") || "<root>"}.`);
		if (params.requireExistingSegment && !Object.prototype.hasOwnProperty.call(cursor, segment)) throw new Error(`Path segment does not exist at ${params.segments.slice(0, index + 1).join(".")}.`);
		cursor = cursor[segment];
	}
	return cursor;
}
function getPath(root, segments) {
	if (segments.length === 0) return;
	let cursor = root;
	for (const segment of segments) {
		if (Array.isArray(cursor)) {
			if (!isArrayIndexSegment(segment)) return;
			cursor = cursor[Number.parseInt(segment, 10)];
			continue;
		}
		if (!isRecord(cursor)) return;
		cursor = cursor[segment];
	}
	return cursor;
}
function setPathCreateStrict(root, segments, value) {
	if (segments.length === 0) throw new Error("Target path is empty.");
	let cursor = root;
	let changed = false;
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index] ?? "";
		const needs = expectedContainer(segments[index + 1] ?? "");
		if (Array.isArray(cursor)) {
			if (!isArrayIndexSegment(segment)) throw new Error(`Invalid array index segment "${segment}" at ${segments.join(".")}.`);
			const arrayIndex = Number.parseInt(segment, 10);
			const existing = cursor[arrayIndex];
			if (existing === void 0 || existing === null) {
				cursor[arrayIndex] = needs === "array" ? [] : {};
				changed = true;
			} else if (needs === "array" ? !Array.isArray(existing) : !isRecord(existing)) throw new Error(`Invalid path shape at ${segments.slice(0, index + 1).join(".")}.`);
			cursor = cursor[arrayIndex];
			continue;
		}
		if (!isRecord(cursor)) throw new Error(`Invalid path shape at ${segments.slice(0, index).join(".") || "<root>"}.`);
		const existing = cursor[segment];
		if (existing === void 0 || existing === null) {
			cursor[segment] = needs === "array" ? [] : {};
			changed = true;
		} else if (needs === "array" ? !Array.isArray(existing) : !isRecord(existing)) throw new Error(`Invalid path shape at ${segments.slice(0, index + 1).join(".")}.`);
		cursor = cursor[segment];
	}
	const leaf = segments[segments.length - 1] ?? "";
	const arrayTarget = parseArrayLeafTarget(cursor, leaf, segments);
	if (arrayTarget) {
		if (!isDeepStrictEqual(arrayTarget.array[arrayTarget.index], value)) {
			arrayTarget.array[arrayTarget.index] = value;
			changed = true;
		}
		return changed;
	}
	if (!isRecord(cursor)) throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);
	if (!isDeepStrictEqual(cursor[leaf], value)) {
		cursor[leaf] = value;
		changed = true;
	}
	return changed;
}
function setPathExistingStrict(root, segments, value) {
	const cursor = traverseToLeafParent({
		root,
		segments,
		requireExistingSegment: true
	});
	const leaf = segments[segments.length - 1] ?? "";
	const arrayTarget = parseArrayLeafTarget(cursor, leaf, segments);
	if (arrayTarget) {
		if (arrayTarget.index < 0 || arrayTarget.index >= arrayTarget.array.length) throw new Error(`Path segment does not exist at ${segments.join(".")}.`);
		if (!isDeepStrictEqual(arrayTarget.array[arrayTarget.index], value)) {
			arrayTarget.array[arrayTarget.index] = value;
			return true;
		}
		return false;
	}
	if (!isRecord(cursor)) throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);
	if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) throw new Error(`Path segment does not exist at ${segments.join(".")}.`);
	if (!isDeepStrictEqual(cursor[leaf], value)) {
		cursor[leaf] = value;
		return true;
	}
	return false;
}
function deletePathStrict(root, segments) {
	const cursor = traverseToLeafParent({
		root,
		segments,
		requireExistingSegment: false
	});
	const leaf = segments[segments.length - 1] ?? "";
	const arrayTarget = parseArrayLeafTarget(cursor, leaf, segments);
	if (arrayTarget) {
		if (arrayTarget.index < 0 || arrayTarget.index >= arrayTarget.array.length) return false;
		arrayTarget.array.splice(arrayTarget.index, 1);
		return true;
	}
	if (!isRecord(cursor)) throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);
	if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) return false;
	delete cursor[leaf];
	return true;
}
//#endregion
export { setPathExistingStrict as i, getPath as n, setPathCreateStrict as r, deletePathStrict as t };
