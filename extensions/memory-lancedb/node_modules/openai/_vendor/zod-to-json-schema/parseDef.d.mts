import { ZodTypeDef } from 'zod/v3';
import { JsonSchema7AnyType } from "./parsers/any.mjs";
import { JsonSchema7ArrayType } from "./parsers/array.mjs";
import { JsonSchema7BigintType } from "./parsers/bigint.mjs";
import { JsonSchema7BooleanType } from "./parsers/boolean.mjs";
import { JsonSchema7DateType } from "./parsers/date.mjs";
import { JsonSchema7EnumType } from "./parsers/enum.mjs";
import { JsonSchema7AllOfType } from "./parsers/intersection.mjs";
import { JsonSchema7LiteralType } from "./parsers/literal.mjs";
import { JsonSchema7MapType } from "./parsers/map.mjs";
import { JsonSchema7NativeEnumType } from "./parsers/nativeEnum.mjs";
import { JsonSchema7NeverType } from "./parsers/never.mjs";
import { JsonSchema7NullType } from "./parsers/null.mjs";
import { JsonSchema7NullableType } from "./parsers/nullable.mjs";
import { JsonSchema7NumberType } from "./parsers/number.mjs";
import { JsonSchema7ObjectType } from "./parsers/object.mjs";
import { JsonSchema7RecordType } from "./parsers/record.mjs";
import { JsonSchema7SetType } from "./parsers/set.mjs";
import { JsonSchema7StringType } from "./parsers/string.mjs";
import { JsonSchema7TupleType } from "./parsers/tuple.mjs";
import { JsonSchema7UndefinedType } from "./parsers/undefined.mjs";
import { JsonSchema7UnionType } from "./parsers/union.mjs";
import { JsonSchema7UnknownType } from "./parsers/unknown.mjs";
import { Refs } from "./Refs.mjs";
type JsonSchema7RefType = {
    $ref: string;
};
type JsonSchema7Meta = {
    title?: string;
    default?: any;
    description?: string;
    markdownDescription?: string;
};
export type JsonSchema7TypeUnion = JsonSchema7StringType | JsonSchema7ArrayType | JsonSchema7NumberType | JsonSchema7BigintType | JsonSchema7BooleanType | JsonSchema7DateType | JsonSchema7EnumType | JsonSchema7LiteralType | JsonSchema7NativeEnumType | JsonSchema7NullType | JsonSchema7NumberType | JsonSchema7ObjectType | JsonSchema7RecordType | JsonSchema7TupleType | JsonSchema7UnionType | JsonSchema7UndefinedType | JsonSchema7RefType | JsonSchema7NeverType | JsonSchema7MapType | JsonSchema7AnyType | JsonSchema7NullableType | JsonSchema7AllOfType | JsonSchema7UnknownType | JsonSchema7SetType;
export type JsonSchema7Type = JsonSchema7TypeUnion & JsonSchema7Meta;
export declare function parseDef(def: ZodTypeDef, refs: Refs, forceResolution?: boolean): JsonSchema7Type | undefined;
export {};
//# sourceMappingURL=parseDef.d.mts.map