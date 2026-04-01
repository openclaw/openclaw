import { Type } from "@sinclair/typebox";
import {
  CHANNEL_TARGET_DESCRIPTION,
  CHANNEL_TARGETS_DESCRIPTION,
} from "../../infra/outbound/channel-target.js";

type StringEnumOptions<T extends readonly string[]> = {
  description?: string;
  title?: string;
  default?: T[number];
};

// NOTE: Avoid Type.Union([Type.Literal(...)]) which compiles to anyOf.
// Some providers reject anyOf in tool schemas; a flat string enum is safer.
export function stringEnum<T extends readonly string[]>(
  values: T,
  options: StringEnumOptions<T> = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

export function optionalStringEnum<T extends readonly string[]>(
  values: T,
  options: StringEnumOptions<T> = {},
) {
  return Type.Optional(stringEnum(values, options));
}

export function channelTargetSchema(options?: { description?: string }) {
  return Type.String({
    description: options?.description ?? CHANNEL_TARGET_DESCRIPTION,
  });
}

export function channelTargetsSchema(options?: { description?: string }) {
  return Type.Array(
    channelTargetSchema({ description: options?.description ?? CHANNEL_TARGETS_DESCRIPTION }),
  );
}
