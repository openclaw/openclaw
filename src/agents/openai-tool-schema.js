import { normalizeToolParameterSchema } from "./pi-tools-parameter-schema.js";
export { resolveOpenAIStrictToolSetting, resolvesToNativeOpenAIStrictTools, } from "./openai-strict-tool-setting.js";
export function normalizeStrictOpenAIJsonSchema(schema) {
    return normalizeStrictOpenAIJsonSchemaRecursive(normalizeToolParameterSchema(schema ?? {}), 0);
}
function normalizeStrictOpenAIJsonSchemaRecursive(schema, depth) {
    if (Array.isArray(schema)) {
        let changed = false;
        const normalized = schema.map((entry) => {
            const next = normalizeStrictOpenAIJsonSchemaRecursive(entry, depth);
            changed ||= next !== entry;
            return next;
        });
        return changed ? normalized : schema;
    }
    if (!schema || typeof schema !== "object") {
        return schema;
    }
    const record = schema;
    let changed = false;
    const normalized = {};
    for (const [key, value] of Object.entries(record)) {
        const next = normalizeStrictOpenAIJsonSchemaRecursive(value, key === "properties" ? depth : depth + 1);
        normalized[key] = next;
        changed ||= next !== value;
    }
    if (normalized.type === "object") {
        const properties = normalized.properties &&
            typeof normalized.properties === "object" &&
            !Array.isArray(normalized.properties)
            ? normalized.properties
            : undefined;
        if (properties && Object.keys(properties).length === 0 && !Array.isArray(normalized.required)) {
            normalized.required = [];
            changed = true;
        }
        if (depth === 0 && !("additionalProperties" in normalized)) {
            normalized.additionalProperties = false;
            changed = true;
        }
    }
    return changed ? normalized : schema;
}
export function normalizeOpenAIStrictToolParameters(schema, strict) {
    if (!strict) {
        return normalizeToolParameterSchema(schema ?? {});
    }
    return normalizeStrictOpenAIJsonSchema(schema);
}
export function isStrictOpenAIJsonSchemaCompatible(schema) {
    return isStrictOpenAIJsonSchemaCompatibleRecursive(normalizeStrictOpenAIJsonSchema(schema));
}
export function findOpenAIStrictToolSchemaDiagnostics(tools) {
    return tools.flatMap((tool, toolIndex) => {
        const violations = findStrictOpenAIJsonSchemaViolations(normalizeStrictOpenAIJsonSchema(tool.parameters), `${typeof tool.name === "string" && tool.name ? tool.name : `tool[${toolIndex}]`}.parameters`);
        if (violations.length === 0) {
            return [];
        }
        return [
            {
                toolIndex,
                ...(typeof tool.name === "string" && tool.name ? { toolName: tool.name } : {}),
                violations,
            },
        ];
    });
}
function isStrictOpenAIJsonSchemaCompatibleRecursive(schema) {
    if (Array.isArray(schema)) {
        return schema.every((entry) => isStrictOpenAIJsonSchemaCompatibleRecursive(entry));
    }
    if (!schema || typeof schema !== "object") {
        return true;
    }
    const record = schema;
    if ("anyOf" in record || "oneOf" in record || "allOf" in record) {
        return false;
    }
    if (Array.isArray(record.type)) {
        return false;
    }
    if (record.type === "object" && record.additionalProperties !== false) {
        return false;
    }
    if (record.type === "object") {
        const properties = record.properties &&
            typeof record.properties === "object" &&
            !Array.isArray(record.properties)
            ? record.properties
            : {};
        const required = Array.isArray(record.required)
            ? record.required.filter((entry) => typeof entry === "string")
            : undefined;
        if (!required) {
            return false;
        }
        const requiredSet = new Set(required);
        if (Object.keys(properties).some((key) => !requiredSet.has(key))) {
            return false;
        }
    }
    return Object.entries(record).every(([key, entry]) => {
        if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
            return Object.values(entry).every((value) => isStrictOpenAIJsonSchemaCompatibleRecursive(value));
        }
        return isStrictOpenAIJsonSchemaCompatibleRecursive(entry);
    });
}
function findStrictOpenAIJsonSchemaViolations(schema, path) {
    if (Array.isArray(schema)) {
        return schema.flatMap((entry, index) => findStrictOpenAIJsonSchemaViolations(entry, `${path}[${index}]`));
    }
    if (!schema || typeof schema !== "object") {
        return [];
    }
    const record = schema;
    const violations = [];
    for (const key of ["anyOf", "oneOf", "allOf"]) {
        if (key in record) {
            violations.push(`${path}.${key}`);
        }
    }
    if (Array.isArray(record.type)) {
        violations.push(`${path}.type`);
    }
    if (record.type === "object") {
        if (record.additionalProperties !== false) {
            violations.push(`${path}.additionalProperties`);
        }
        const properties = record.properties &&
            typeof record.properties === "object" &&
            !Array.isArray(record.properties)
            ? record.properties
            : {};
        const required = Array.isArray(record.required)
            ? record.required.filter((entry) => typeof entry === "string")
            : undefined;
        if (!required) {
            violations.push(`${path}.required`);
        }
        else {
            const requiredSet = new Set(required);
            for (const key of Object.keys(properties)) {
                if (!requiredSet.has(key)) {
                    violations.push(`${path}.required.${key}`);
                }
            }
        }
    }
    if (record.properties &&
        typeof record.properties === "object" &&
        !Array.isArray(record.properties)) {
        for (const [key, value] of Object.entries(record.properties)) {
            violations.push(...findStrictOpenAIJsonSchemaViolations(value, `${path}.properties.${key}`));
        }
    }
    for (const [key, value] of Object.entries(record)) {
        if (key === "properties") {
            continue;
        }
        if (value && typeof value === "object") {
            violations.push(...findStrictOpenAIJsonSchemaViolations(value, `${path}.${key}`));
        }
    }
    return violations;
}
export function resolveOpenAIStrictToolFlagForInventory(tools, strict) {
    if (strict !== true) {
        return strict === false ? false : undefined;
    }
    return tools.every((tool) => isStrictOpenAIJsonSchemaCompatible(tool.parameters));
}
