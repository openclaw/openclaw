const RETRY_GUIDANCE_SUFFIX = " Supply correct parameters before retrying.";
function parameterValidationError(message) {
    return new Error(`${message}.${RETRY_GUIDANCE_SUFFIX}`);
}
function describeReceivedParamValue(value, allowEmpty = false) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === "string") {
        if (allowEmpty || value.trim().length > 0) {
            return undefined;
        }
        return "<empty-string>";
    }
    if (Array.isArray(value)) {
        return "<array>";
    }
    return `<${typeof value}>`;
}
function formatReceivedParamHint(record, groups) {
    const allowEmptyKeys = new Set(groups.filter((group) => group.allowEmpty).flatMap((group) => group.keys));
    const received = Object.keys(record).flatMap((key) => {
        const detail = describeReceivedParamValue(record[key], allowEmptyKeys.has(key));
        if (record[key] === undefined || record[key] === null) {
            return [];
        }
        return [detail ? `${key}=${detail}` : key];
    });
    return received.length > 0 ? ` (received: ${received.join(", ")})` : "";
}
function isValidEditReplacement(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const record = value;
    return (typeof record.oldText === "string" &&
        record.oldText.trim().length > 0 &&
        typeof record.newText === "string");
}
function hasValidEditReplacements(record) {
    const edits = record.edits;
    return (Array.isArray(edits) &&
        edits.length > 0 &&
        edits.every((entry) => isValidEditReplacement(entry)));
}
export const REQUIRED_PARAM_GROUPS = {
    read: [{ keys: ["path"], label: "path" }],
    write: [
        { keys: ["path"], label: "path" },
        { keys: ["content"], label: "content" },
    ],
    edit: [
        { keys: ["path"], label: "path" },
        { keys: ["edits"], label: "edits", validator: hasValidEditReplacements },
    ],
};
export function getToolParamsRecord(params) {
    return params && typeof params === "object" ? params : undefined;
}
export function assertRequiredParams(record, groups, toolName) {
    if (!record || typeof record !== "object") {
        throw parameterValidationError(`Missing parameters for ${toolName}`);
    }
    const missingLabels = [];
    for (const group of groups) {
        const satisfied = group.validator?.(record) ??
            group.keys.some((key) => {
                if (!(key in record)) {
                    return false;
                }
                const value = record[key];
                if (typeof value !== "string") {
                    return false;
                }
                if (group.allowEmpty) {
                    return true;
                }
                return value.trim().length > 0;
            });
        if (!satisfied) {
            const label = group.label ?? group.keys.join(" or ");
            missingLabels.push(label);
        }
    }
    if (missingLabels.length > 0) {
        const joined = missingLabels.join(", ");
        const noun = missingLabels.length === 1 ? "parameter" : "parameters";
        const receivedHint = formatReceivedParamHint(record, groups);
        throw parameterValidationError(`Missing required ${noun}: ${joined}${receivedHint}`);
    }
}
export function wrapToolParamValidation(tool, requiredParamGroups) {
    return {
        ...tool,
        execute: async (toolCallId, params, signal, onUpdate) => {
            const record = getToolParamsRecord(params);
            if (requiredParamGroups?.length) {
                assertRequiredParams(record, requiredParamGroups, tool.name);
            }
            return tool.execute(toolCallId, params, signal, onUpdate);
        },
    };
}
