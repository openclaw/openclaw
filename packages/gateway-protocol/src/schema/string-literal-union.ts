import { Type, type TLiteral, type TUnion } from "typebox";

type LiteralTuple<Values extends readonly string[]> = {
  -readonly [Index in keyof Values]: TLiteral<Values[Index]>;
};

/** Preserve the protocol's ordered anyOf shape and TypeBox's tuple-based inference. */
export function stringLiteralUnion<const Values extends readonly string[]>(
  values: Values,
): TUnion<LiteralTuple<Values>> {
  // SAFETY: Array.map preserves length and order, but TypeScript loses tuple positions.
  const literals = values.map((value) => Type.Literal(value)) as [...LiteralTuple<Values>];
  return Type.Union<LiteralTuple<Values>>(literals);
}
