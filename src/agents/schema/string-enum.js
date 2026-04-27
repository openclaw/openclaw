import { Type } from "typebox";
// Avoid Type.Union([Type.Literal(...)]) which compiles to anyOf.
// Some providers reject anyOf in tool schemas; a flat string enum is safer.
export function stringEnum(values, options = {}) {
    const enumValues = Array.isArray(values)
        ? values
        : values && typeof values === "object"
            ? Object.values(values).filter((value) => typeof value === "string")
            : [];
    return Type.Unsafe({
        type: "string",
        ...(enumValues.length > 0 ? { enum: [...enumValues] } : {}),
        ...options,
    });
}
export function optionalStringEnum(values, options = {}) {
    return Type.Optional(stringEnum(values, options));
}
