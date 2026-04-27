import path from "node:path";
import { expandHomePrefix, resolveOsHomeDir } from "../infra/home-dir.js";
import { getToolParamsRecord } from "./pi-tools.params.js";
const EDIT_MISMATCH_MESSAGE = "Could not find the exact text in";
const EDIT_MISMATCH_HINT_LIMIT = 800;
function resolveEditPath(root, pathParam) {
    const home = resolveOsHomeDir();
    const expanded = home ? expandHomePrefix(pathParam, { home }) : pathParam;
    return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}
function readStringParam(record, ...keys) {
    for (const key of keys) {
        const value = record?.[key];
        if (typeof value === "string") {
            return value;
        }
    }
    return undefined;
}
function readEditReplacements(record) {
    if (!Array.isArray(record?.edits)) {
        return [];
    }
    return record.edits.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
            return [];
        }
        const replacement = entry;
        if (typeof replacement.oldText !== "string" || replacement.oldText.trim().length === 0) {
            return [];
        }
        if (typeof replacement.newText !== "string") {
            return [];
        }
        return [{ oldText: replacement.oldText, newText: replacement.newText }];
    });
}
function readEditToolParams(params) {
    const record = getToolParamsRecord(params);
    return {
        pathParam: readStringParam(record, "path"),
        edits: readEditReplacements(record),
    };
}
function normalizeToLF(value) {
    return value.replace(/\r\n?/g, "\n");
}
function removeExactOccurrences(content, needle) {
    return needle.length > 0 ? content.split(needle).join("") : content;
}
function didEditLikelyApply(params) {
    if (params.edits.length === 0) {
        return false;
    }
    const normalizedCurrent = normalizeToLF(params.currentContent);
    const normalizedOriginal = typeof params.originalContent === "string" ? normalizeToLF(params.originalContent) : undefined;
    if (normalizedOriginal !== undefined && normalizedOriginal === normalizedCurrent) {
        return false;
    }
    let withoutInsertedNewText = normalizedCurrent;
    for (const edit of params.edits) {
        const normalizedNew = normalizeToLF(edit.newText);
        if (normalizedNew.length > 0 && !normalizedCurrent.includes(normalizedNew)) {
            return false;
        }
        withoutInsertedNewText =
            normalizedNew.length > 0
                ? removeExactOccurrences(withoutInsertedNewText, normalizedNew)
                : withoutInsertedNewText;
    }
    for (const edit of params.edits) {
        const normalizedOld = normalizeToLF(edit.oldText);
        if (withoutInsertedNewText.includes(normalizedOld)) {
            return false;
        }
    }
    return true;
}
function buildEditSuccessResult(pathParam, editCount) {
    const text = editCount > 1
        ? `Successfully replaced ${editCount} block(s) in ${pathParam}.`
        : `Successfully replaced text in ${pathParam}.`;
    return {
        isError: false,
        content: [
            {
                type: "text",
                text,
            },
        ],
        details: { diff: "", firstChangedLine: undefined },
    };
}
function shouldAddMismatchHint(error) {
    return error instanceof Error && error.message.includes(EDIT_MISMATCH_MESSAGE);
}
function appendMismatchHint(error, currentContent) {
    const snippet = currentContent.length <= EDIT_MISMATCH_HINT_LIMIT
        ? currentContent
        : `${currentContent.slice(0, EDIT_MISMATCH_HINT_LIMIT)}\n... (truncated)`;
    const enhanced = new Error(`${error.message}\nCurrent file contents:\n${snippet}`);
    enhanced.stack = error.stack;
    return enhanced;
}
/**
 * Recover from two edit-tool failure classes without changing edit semantics:
 * - exact-match mismatch errors become actionable by including current file contents
 * - post-write throws are converted back to success only if the file actually changed
 */
export function wrapEditToolWithRecovery(base, options) {
    return {
        ...base,
        execute: async (toolCallId, params, signal, onUpdate) => {
            const { pathParam, edits } = readEditToolParams(params);
            const absolutePath = typeof pathParam === "string" ? resolveEditPath(options.root, pathParam) : undefined;
            let originalContent;
            if (absolutePath && edits.length > 0) {
                try {
                    originalContent = await options.readFile(absolutePath);
                }
                catch {
                    // Best-effort snapshot only; recovery should still proceed without it.
                }
            }
            try {
                return await base.execute(toolCallId, params, signal, onUpdate);
            }
            catch (err) {
                if (!absolutePath) {
                    throw err;
                }
                let currentContent;
                try {
                    currentContent = await options.readFile(absolutePath);
                }
                catch {
                    // Fall through to the original error if readback fails.
                }
                if (typeof currentContent === "string" && edits.length > 0) {
                    if (didEditLikelyApply({
                        originalContent,
                        currentContent,
                        edits,
                    })) {
                        return buildEditSuccessResult(pathParam ?? absolutePath, edits.length);
                    }
                }
                if (typeof currentContent === "string" &&
                    err instanceof Error &&
                    shouldAddMismatchHint(err)) {
                    throw appendMismatchHint(err, currentContent);
                }
                throw err;
            }
        },
    };
}
