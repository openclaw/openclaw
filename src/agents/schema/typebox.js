import { Type } from "@sinclair/typebox";
import { CHANNEL_TARGET_DESCRIPTION, CHANNEL_TARGETS_DESCRIPTION, } from "../../infra/outbound/channel-target.js";
// NOTE: Avoid Type.Union([Type.Literal(...)]) which compiles to anyOf.
// Some providers reject anyOf in tool schemas; a flat string enum is safer.
export function stringEnum(values, options = {}) {
    return Type.Unsafe({
        type: "string",
        enum: [...values],
        ...options,
    });
}
export function optionalStringEnum(values, options = {}) {
    return Type.Optional(stringEnum(values, options));
}
export function channelTargetSchema(options) {
    return Type.String({
        description: options?.description ?? CHANNEL_TARGET_DESCRIPTION,
    });
}
export function channelTargetsSchema(options) {
    return Type.Array(channelTargetSchema({ description: options?.description ?? CHANNEL_TARGETS_DESCRIPTION }));
}
