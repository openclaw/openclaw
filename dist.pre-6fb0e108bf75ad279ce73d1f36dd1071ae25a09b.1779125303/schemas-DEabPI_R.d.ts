declare namespace json_schema_d_exports {
  export { ArraySchema, BaseSchema, BooleanSchema, IntegerSchema, JSONSchema, NullSchema, NumberSchema, ObjectSchema, Schema, StringSchema, _JSONSchema };
}
type Schema = ObjectSchema | ArraySchema | StringSchema | NumberSchema | IntegerSchema | BooleanSchema | NullSchema;
type _JSONSchema = boolean | JSONSchema;
type JSONSchema = {
  [k: string]: unknown;
  $schema?: "https://json-schema.org/draft/2020-12/schema" | "http://json-schema.org/draft-07/schema#" | "http://json-schema.org/draft-04/schema#";
  $id?: string;
  $anchor?: string;
  $ref?: string;
  $dynamicRef?: string;
  $dynamicAnchor?: string;
  $vocabulary?: Record<string, boolean>;
  $comment?: string;
  $defs?: Record<string, JSONSchema>;
  type?: "object" | "array" | "string" | "number" | "boolean" | "null" | "integer";
  additionalItems?: _JSONSchema;
  unevaluatedItems?: _JSONSchema;
  prefixItems?: _JSONSchema[];
  items?: _JSONSchema | _JSONSchema[];
  contains?: _JSONSchema;
  additionalProperties?: _JSONSchema;
  unevaluatedProperties?: _JSONSchema;
  properties?: Record<string, _JSONSchema>;
  patternProperties?: Record<string, _JSONSchema>;
  dependentSchemas?: Record<string, _JSONSchema>;
  propertyNames?: _JSONSchema;
  if?: _JSONSchema;
  then?: _JSONSchema;
  else?: _JSONSchema;
  allOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  not?: _JSONSchema;
  multipleOf?: number;
  maximum?: number;
  exclusiveMaximum?: number | boolean;
  minimum?: number;
  exclusiveMinimum?: number | boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  maxItems?: number;
  minItems?: number;
  uniqueItems?: boolean;
  maxContains?: number;
  minContains?: number;
  maxProperties?: number;
  minProperties?: number;
  required?: string[];
  dependentRequired?: Record<string, string[]>;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  id?: string;
  title?: string;
  description?: string;
  default?: unknown;
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  nullable?: boolean;
  examples?: unknown[];
  format?: string;
  contentMediaType?: string;
  contentEncoding?: string;
  contentSchema?: JSONSchema;
  _prefault?: unknown;
};
type BaseSchema = JSONSchema;
interface ObjectSchema extends JSONSchema {
  type: "object";
}
interface ArraySchema extends JSONSchema {
  type: "array";
}
interface StringSchema extends JSONSchema {
  type: "string";
}
interface NumberSchema extends JSONSchema {
  type: "number";
}
interface IntegerSchema extends JSONSchema {
  type: "integer";
}
interface BooleanSchema extends JSONSchema {
  type: "boolean";
}
interface NullSchema extends JSONSchema {
  type: "null";
}
//#endregion
//#region node_modules/zod/v4/core/standard-schema.d.cts
/** The Standard interface. */
interface StandardTypedV1<Input = unknown, Output = Input> {
  /** The Standard properties. */
  readonly "~standard": StandardTypedV1.Props<Input, Output>;
}
declare namespace StandardTypedV1 {
  /** The Standard properties interface. */
  interface Props<Input = unknown, Output = Input> {
    /** The version number of the standard. */
    readonly version: 1;
    /** The vendor name of the schema library. */
    readonly vendor: string;
    /** Inferred types associated with the schema. */
    readonly types?: Types<Input, Output> | undefined;
  }
  /** The Standard types interface. */
  interface Types<Input = unknown, Output = Input> {
    /** The input type of the schema. */
    readonly input: Input;
    /** The output type of the schema. */
    readonly output: Output;
  }
  /** Infers the input type of a Standard. */
  type InferInput<Schema extends StandardTypedV1> = NonNullable<Schema["~standard"]["types"]>["input"];
  /** Infers the output type of a Standard. */
  type InferOutput<Schema extends StandardTypedV1> = NonNullable<Schema["~standard"]["types"]>["output"];
}
/** The Standard Schema interface. */
interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}
declare namespace StandardSchemaV1 {
  /** The Standard Schema properties interface. */
  interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
    /** Validates unknown input values. */
    readonly validate: (value: unknown, options?: StandardSchemaV1.Options | undefined) => Result<Output> | Promise<Result<Output>>;
  }
  /** The result interface of the validate function. */
  type Result<Output> = SuccessResult<Output> | FailureResult;
  /** The result interface if validation succeeds. */
  interface SuccessResult<Output> {
    /** The typed output value. */
    readonly value: Output;
    /** The absence of issues indicates success. */
    readonly issues?: undefined;
  }
  interface Options {
    /** Implicit support for additional vendor-specific parameters, if needed. */
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }
  /** The result interface if validation fails. */
  interface FailureResult {
    /** The issues of failed validation. */
    readonly issues: ReadonlyArray<Issue>;
  }
  /** The issue interface of the failure output. */
  interface Issue {
    /** The error message of the issue. */
    readonly message: string;
    /** The path of the issue, if any. */
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  /** The path segment interface of the issue. */
  interface PathSegment {
    /** The key representing a path segment. */
    readonly key: PropertyKey;
  }
  /** The Standard types interface. */
  interface Types<Input = unknown, Output = Input> extends StandardTypedV1.Types<Input, Output> {}
  /** Infers the input type of a Standard. */
  type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
  /** Infers the output type of a Standard. */
  type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}
/** The Standard JSON Schema interface. */
interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  /** The Standard JSON Schema properties. */
  readonly "~standard": StandardJSONSchemaV1.Props<Input, Output>;
}
declare namespace StandardJSONSchemaV1 {
  /** The Standard JSON Schema properties interface. */
  interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
    /** Methods for generating the input/output JSON Schema. */
    readonly jsonSchema: Converter;
  }
  /** The Standard JSON Schema converter interface. */
  interface Converter {
    /** Converts the input type to JSON Schema. May throw if conversion is not supported. */
    readonly input: (options: StandardJSONSchemaV1.Options) => Record<string, unknown>;
    /** Converts the output type to JSON Schema. May throw if conversion is not supported. */
    readonly output: (options: StandardJSONSchemaV1.Options) => Record<string, unknown>;
  }
  /** The target version of the generated JSON Schema.
   *
   * It is *strongly recommended* that implementers support `"draft-2020-12"` and `"draft-07"`, as they are both in wide use.
   *
   * The `"openapi-3.0"` target is intended as a standardized specifier for OpenAPI 3.0 which is a superset of JSON Schema `"draft-04"`.
   *
   * All other targets can be implemented on a best-effort basis. Libraries should throw if they don't support a specified target.
   */
  type Target = "draft-2020-12" | "draft-07" | "openapi-3.0" | ({} & string);
  /** The options for the input/output methods. */
  interface Options {
    /** Specifies the target version of the generated JSON Schema. Support for all versions is on a best-effort basis. If a given version is not supported, the library should throw. */
    readonly target: Target;
    /** Implicit support for additional vendor-specific parameters, if needed. */
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }
  /** The Standard types interface. */
  interface Types<Input = unknown, Output = Input> extends StandardTypedV1.Types<Input, Output> {}
  /** Infers the input type of a Standard. */
  type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
  /** Infers the output type of a Standard. */
  type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}
interface StandardSchemaWithJSONProps<Input = unknown, Output = Input> extends StandardSchemaV1.Props<Input, Output>, StandardJSONSchemaV1.Props<Input, Output> {}
//#endregion
//#region node_modules/zod/v4/core/registries.d.cts
declare const $output: unique symbol;
type $output = typeof $output;
declare const $input: unique symbol;
type $input = typeof $input;
type $replace<Meta, S extends $ZodType> = Meta extends $output ? output<S> : Meta extends $input ? input<S> : Meta extends (infer M)[] ? $replace<M, S>[] : Meta extends ((...args: infer P) => infer R) ? (...args: { [K in keyof P]: $replace<P[K], S> }) => $replace<R, S> : Meta extends object ? { [K in keyof Meta]: $replace<Meta[K], S> } : Meta;
type MetadataType = object | undefined;
declare class $ZodRegistry<Meta extends MetadataType = MetadataType, Schema extends $ZodType = $ZodType> {
  _meta: Meta;
  _schema: Schema;
  _map: WeakMap<Schema, $replace<Meta, Schema>>;
  _idmap: Map<string, Schema>;
  add<S extends Schema>(schema: S, ..._meta: undefined extends Meta ? [$replace<Meta, S>?] : [$replace<Meta, S>]): this;
  clear(): this;
  remove(schema: Schema): this;
  get<S extends Schema>(schema: S): $replace<Meta, S> | undefined;
  has(schema: Schema): boolean;
}
interface JSONSchemaMeta {
  id?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  deprecated?: boolean | undefined;
  [k: string]: unknown;
}
interface GlobalMeta extends JSONSchemaMeta {}
declare function registry<T extends MetadataType = MetadataType, S extends $ZodType = $ZodType>(): $ZodRegistry<T, S>;
declare const globalRegistry: $ZodRegistry<GlobalMeta>;
//#endregion
//#region node_modules/zod/v4/core/to-json-schema.d.cts
type Processor<T extends $ZodType = $ZodType> = (schema: T, ctx: ToJSONSchemaContext, json: BaseSchema, params: ProcessParams) => void;
interface JSONSchemaGeneratorParams {
  processors: Record<string, Processor>;
  /** A registry used to look up metadata for each schema. Any schema with an `id` property will be extracted as a $def.
   *  @default globalRegistry */
  metadata?: $ZodRegistry<Record<string, any>>;
  /** The JSON Schema version to target.
   * - `"draft-2020-12"` — Default. JSON Schema Draft 2020-12
   * - `"draft-07"` — JSON Schema Draft 7
   * - `"draft-04"` — JSON Schema Draft 4
   * - `"openapi-3.0"` — OpenAPI 3.0 Schema Object */
  target?: "draft-04" | "draft-07" | "draft-2020-12" | "openapi-3.0" | ({} & string) | undefined;
  /** How to handle unrepresentable types.
   * - `"throw"` — Default. Unrepresentable types throw an error
   * - `"any"` — Unrepresentable types become `{}` */
  unrepresentable?: "throw" | "any";
  /** Arbitrary custom logic that can be used to modify the generated JSON Schema. */
  override?: (ctx: {
    zodSchema: $ZodTypes;
    jsonSchema: BaseSchema;
    path: (string | number)[];
  }) => void;
  /** Whether to extract the `"input"` or `"output"` type. Relevant to transforms, defaults, coerced primitives, etc.
   * - `"output"` — Default. Convert the output schema.
   * - `"input"` — Convert the input schema. */
  io?: "input" | "output";
  cycles?: "ref" | "throw";
  reused?: "ref" | "inline";
  external?: {
    registry: $ZodRegistry<{
      id?: string | undefined;
    }>;
    uri?: ((id: string) => string) | undefined;
    defs: Record<string, BaseSchema>;
  } | undefined;
}
/**
 * Parameters for the toJSONSchema function.
 */
type ToJSONSchemaParams = Omit<JSONSchemaGeneratorParams, "processors" | "external">;
/**
 * Parameters for the toJSONSchema function when passing a registry.
 */
interface RegistryToJSONSchemaParams extends ToJSONSchemaParams {
  uri?: (id: string) => string;
}
interface ProcessParams {
  schemaPath: $ZodType[];
  path: (string | number)[];
}
interface Seen {
  /** JSON Schema result for this Zod schema */
  schema: BaseSchema;
  /** A cached version of the schema that doesn't get overwritten during ref resolution */
  def?: BaseSchema;
  defId?: string | undefined;
  /** Number of times this schema was encountered during traversal */
  count: number;
  /** Cycle path */
  cycle?: (string | number)[] | undefined;
  isParent?: boolean | undefined;
  /** Schema to inherit JSON Schema properties from (set by processor for wrappers) */
  ref?: $ZodType | null;
  /** JSON Schema property path for this schema */
  path?: (string | number)[] | undefined;
}
interface ToJSONSchemaContext {
  processors: Record<string, Processor>;
  metadataRegistry: $ZodRegistry<Record<string, any>>;
  target: "draft-04" | "draft-07" | "draft-2020-12" | "openapi-3.0" | ({} & string);
  unrepresentable: "throw" | "any";
  override: (ctx: {
    zodSchema: $ZodType;
    jsonSchema: BaseSchema;
    path: (string | number)[];
  }) => void;
  io: "input" | "output";
  counter: number;
  seen: Map<$ZodType, Seen>;
  cycles: "ref" | "throw";
  reused: "ref" | "inline";
  external?: {
    registry: $ZodRegistry<{
      id?: string | undefined;
    }>;
    uri?: ((id: string) => string) | undefined;
    defs: Record<string, BaseSchema>;
  } | undefined;
}
declare function initializeContext(params: JSONSchemaGeneratorParams): ToJSONSchemaContext;
declare function process<T extends $ZodType>(schema: T, ctx: ToJSONSchemaContext, _params?: ProcessParams): BaseSchema;
declare function extractDefs<T extends $ZodType>(ctx: ToJSONSchemaContext, schema: T): void;
declare function finalize<T extends $ZodType>(ctx: ToJSONSchemaContext, schema: T): ZodStandardJSONSchemaPayload<T>;
type ZodStandardSchemaWithJSON$1<T> = StandardSchemaWithJSONProps<input<T>, output<T>>;
interface ZodStandardJSONSchemaPayload<T> extends BaseSchema {
  "~standard": ZodStandardSchemaWithJSON$1<T>;
}
/**
 * Creates a toJSONSchema method for a schema instance.
 * This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
 */
declare const createToJSONSchemaMethod: <T extends $ZodType>(schema: T, processors?: Record<string, Processor>) => (params?: ToJSONSchemaParams) => ZodStandardJSONSchemaPayload<T>;
/**
 * Creates a toJSONSchema method for a schema instance.
 * This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
 */
type StandardJSONSchemaMethodParams = Parameters<StandardJSONSchemaV1["~standard"]["jsonSchema"]["input"]>[0];
declare const createStandardJSONSchemaMethod: <T extends $ZodType>(schema: T, io: "input" | "output", processors?: Record<string, Processor>) => (params?: StandardJSONSchemaMethodParams) => BaseSchema;
declare namespace util_d_exports {
  export { AnyFunc, AssertEqual, AssertExtends, AssertNotEqual, BIGINT_FORMAT_RANGES, BuiltIn, Class, CleanKey, Constructor, EmptyObject, EmptyToNever, EnumLike, EnumValue, Exactly, Extend, ExtractIndexSignature, Flatten, FromCleanMap, HasLength, HasSize, HashAlgorithm, HashEncoding, HashFormat, IPVersion, Identity, InexactPartial, IsAny, IsProp, JSONType, JWTAlgorithm, KeyOf, Keys, KeysArray, KeysEnum, Literal, LiteralArray, LoosePartial, MakePartial, MakeReadonly, MakeRequired, Mapped, Mask, MaybeAsync, MimeTypes, NUMBER_FORMAT_RANGES, NoNever, NoNeverKeys, NoUndefined, Normalize, Numeric, Omit$1 as Omit, OmitIndexSignature, OmitKeys, ParsedTypes, Prettify, Primitive, PrimitiveArray, PrimitiveSet, PropValues, SafeParseError, SafeParseResult, SafeParseSuccess, SchemaClass, SomeObject, ToCleanMap, ToEnum, TupleItems, Whatever, Writeable, aborted, allowsEval, assert, assertEqual, assertIs, assertNever, assertNotEqual, assignProp, base64ToUint8Array, base64urlToUint8Array, cached, captureStackTrace, cleanEnum, cleanRegex, clone, cloneDef, createTransparentProxy, defineLazy, esc, escapeRegex, explicitlyAborted, extend, finalizeIssue, floatSafeRemainder, getElementAtPath, getEnumValues, getLengthableOrigin, getParsedType, getSizableOrigin, hexToUint8Array, isObject, isPlainObject, issue, joinValues, jsonStringifyReplacer, merge, mergeDefs, normalizeParams, nullish$1 as nullish, numKeys, objectClone, omit, optionalKeys, parsedType, partial, pick, prefixIssues, primitiveTypes, promiseAllObject, propertyKeyTypes, randomString, required, safeExtend, shallowClone, slugify, stringifyPrimitive, uint8ArrayToBase64, uint8ArrayToBase64url, uint8ArrayToHex, unwrapMessage };
}
type JSONType = string | number | boolean | null | JSONType[] | {
  [key: string]: JSONType;
};
type JWTAlgorithm = "HS256" | "HS384" | "HS512" | "RS256" | "RS384" | "RS512" | "ES256" | "ES384" | "ES512" | "PS256" | "PS384" | "PS512" | "EdDSA" | (string & {});
type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha384" | "sha512";
type HashEncoding = "hex" | "base64" | "base64url";
type HashFormat = `${HashAlgorithm}_${HashEncoding}`;
type IPVersion = "v4" | "v6";
type MimeTypes = "application/json" | "application/xml" | "application/x-www-form-urlencoded" | "application/javascript" | "application/pdf" | "application/zip" | "application/vnd.ms-excel" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" | "application/msword" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/vnd.ms-powerpoint" | "application/vnd.openxmlformats-officedocument.presentationml.presentation" | "application/octet-stream" | "application/graphql" | "text/html" | "text/plain" | "text/css" | "text/javascript" | "text/csv" | "image/png" | "image/jpeg" | "image/gif" | "image/svg+xml" | "image/webp" | "audio/mpeg" | "audio/ogg" | "audio/wav" | "audio/webm" | "video/mp4" | "video/webm" | "video/ogg" | "font/woff" | "font/woff2" | "font/ttf" | "font/otf" | "multipart/form-data" | (string & {});
type ParsedTypes = "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function" | "file" | "date" | "array" | "map" | "set" | "nan" | "null" | "promise";
type AssertEqual<T, U> = (<V>() => V extends T ? 1 : 2) extends (<V>() => V extends U ? 1 : 2) ? true : false;
type AssertNotEqual<T, U> = (<V>() => V extends T ? 1 : 2) extends (<V>() => V extends U ? 1 : 2) ? false : true;
type AssertExtends<T, U> = T extends U ? T : never;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Omit$1<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
type OmitKeys<T, K extends string> = Pick<T, Exclude<keyof T, K>>;
type MakePartial<T, K extends keyof T> = Omit$1<T, K> & InexactPartial<Pick<T, K>>;
type MakeRequired<T, K extends keyof T> = Omit$1<T, K> & Required<Pick<T, K>>;
type Exactly<T, X> = T & Record<Exclude<keyof X, keyof T>, never>;
type NoUndefined<T> = T extends undefined ? never : T;
type Whatever = {} | undefined | null;
type LoosePartial<T extends object> = InexactPartial<T> & {
  [k: string]: unknown;
};
type Mask<Keys extends PropertyKey> = { [K in Keys]?: true };
type Writeable<T> = { -readonly [P in keyof T]: T[P] } & {};
type InexactPartial<T> = { [P in keyof T]?: T[P] | undefined };
type EmptyObject = Record<string, never>;
type BuiltIn = (((...args: any[]) => any) | (new (...args: any[]) => any)) | {
  readonly [Symbol.toStringTag]: string;
} | Date | Error | Generator | Promise<unknown> | RegExp;
type MakeReadonly<T> = T extends Map<infer K, infer V> ? ReadonlyMap<K, V> : T extends Set<infer V> ? ReadonlySet<V> : T extends [infer Head, ...infer Tail] ? readonly [Head, ...Tail] : T extends Array<infer V> ? ReadonlyArray<V> : T extends BuiltIn ? T : Readonly<T>;
type SomeObject = Record<PropertyKey, any>;
type Identity<T> = T;
type Flatten<T> = Identity<{ [k in keyof T]: T[k] }>;
type Mapped<T> = { [k in keyof T]: T[k] };
type Prettify<T> = { [K in keyof T]: T[K] } & {};
type NoNeverKeys<T> = { [k in keyof T]: [T[k]] extends [never] ? never : k }[keyof T];
type NoNever<T> = Identity<{ [k in NoNeverKeys<T>]: k extends keyof T ? T[k] : never }>;
type Extend<A extends SomeObject, B extends SomeObject> = Flatten<keyof A & keyof B extends never ? A & B : { [K in keyof A as K extends keyof B ? never : K]: A[K] } & { [K in keyof B]: B[K] }>;
type TupleItems = ReadonlyArray<SomeType>;
type AnyFunc = (...args: any[]) => any;
type IsProp<T, K extends keyof T> = T[K] extends AnyFunc ? never : K;
type MaybeAsync<T> = T | Promise<T>;
type KeyOf<T> = keyof OmitIndexSignature<T>;
type OmitIndexSignature<T> = { [K in keyof T as string extends K ? never : K extends string ? K : never]: T[K] };
type ExtractIndexSignature<T> = { [K in keyof T as string extends K ? K : K extends string ? never : K]: T[K] };
type Keys<T extends object> = keyof OmitIndexSignature<T>;
type SchemaClass<T extends SomeType> = {
  new (def: T["_zod"]["def"]): T;
};
type EnumValue = string | number;
type EnumLike = Readonly<Record<string, EnumValue>>;
type ToEnum<T extends EnumValue> = Flatten<{ [k in T]: k }>;
type KeysEnum<T extends object> = ToEnum<Exclude<keyof T, symbol>>;
type KeysArray<T extends object> = Flatten<(keyof T & string)[]>;
type Literal = string | number | bigint | boolean | null | undefined;
type LiteralArray = Array<Literal>;
type Primitive = string | number | symbol | bigint | boolean | null | undefined;
type PrimitiveArray = Array<Primitive>;
type HasSize = {
  size: number;
};
type HasLength = {
  length: number;
};
type Numeric = number | bigint | Date;
type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseError<T>;
type SafeParseSuccess<T> = {
  success: true;
  data: T;
  error?: never;
};
type SafeParseError<T> = {
  success: false;
  data?: never;
  error: $ZodError<T>;
};
type PropValues = Record<string, Set<Primitive>>;
type PrimitiveSet = Set<Primitive>;
declare function assertEqual<A, B>(val: AssertEqual<A, B>): AssertEqual<A, B>;
declare function assertNotEqual<A, B>(val: AssertNotEqual<A, B>): AssertNotEqual<A, B>;
declare function assertIs<T>(_arg: T): void;
declare function assertNever(_x: never): never;
declare function assert<T>(_: any): asserts _ is T;
declare function getEnumValues(entries: EnumLike): EnumValue[];
declare function joinValues<T extends Primitive[]>(array: T, separator?: string): string;
declare function jsonStringifyReplacer(_: string, value: any): any;
declare function cached<T>(getter: () => T): {
  value: T;
};
declare function nullish$1(input: any): boolean;
declare function cleanRegex(source: string): string;
declare function floatSafeRemainder(val: number, step: number): number;
declare function defineLazy<T, K extends keyof T>(object: T, key: K, getter: () => T[K]): void;
declare function objectClone(obj: object): any;
declare function assignProp<T extends object, K extends PropertyKey>(target: T, prop: K, value: K extends keyof T ? T[K] : any): void;
declare function mergeDefs(...defs: Record<string, any>[]): any;
declare function cloneDef(schema: $ZodType): any;
declare function getElementAtPath(obj: any, path: (string | number)[] | null | undefined): any;
declare function promiseAllObject<T extends object>(promisesObj: T): Promise<{ [k in keyof T]: Awaited<T[k]> }>;
declare function randomString(length?: number): string;
declare function esc(str: string): string;
declare function slugify(input: string): string;
declare const captureStackTrace: (targetObject: object, constructorOpt?: Function) => void;
declare function isObject(data: any): data is Record<PropertyKey, unknown>;
declare const allowsEval: {
  value: boolean;
};
declare function isPlainObject(o: any): o is Record<PropertyKey, unknown>;
declare function shallowClone(o: any): any;
declare function numKeys(data: any): number;
declare const getParsedType: (data: any) => ParsedTypes;
declare const propertyKeyTypes: Set<string>;
declare const primitiveTypes: Set<string>;
declare function escapeRegex(str: string): string;
declare function clone<T extends $ZodType>(inst: T, def?: T["_zod"]["def"], params?: {
  parent: boolean;
}): T;
type EmptyToNever<T> = keyof T extends never ? never : T;
type Normalize<T> = T extends undefined ? never : T extends Record<any, any> ? Flatten<{ [k in keyof Omit$1<T, "error" | "message">]: T[k] } & ("error" extends keyof T ? {
  error?: Exclude<T["error"], string>;
} : unknown)> : never;
declare function normalizeParams<T>(_params: T): Normalize<T>;
declare function createTransparentProxy<T extends object>(getter: () => T): T;
declare function stringifyPrimitive(value: any): string;
declare function optionalKeys(shape: $ZodShape): string[];
type CleanKey<T extends PropertyKey> = T extends `?${infer K}` ? K : T extends `${infer K}?` ? K : T;
type ToCleanMap<T extends $ZodLooseShape> = { [k in keyof T]: k extends `?${infer K}` ? K : k extends `${infer K}?` ? K : k };
type FromCleanMap<T extends $ZodLooseShape> = { [k in keyof T as k extends `?${infer K}` ? K : k extends `${infer K}?` ? K : k]: k };
declare const NUMBER_FORMAT_RANGES: Record<$ZodNumberFormats, [number, number]>;
declare const BIGINT_FORMAT_RANGES: Record<$ZodBigIntFormats, [bigint, bigint]>;
declare function pick(schema: $ZodObject, mask: Record<string, unknown>): any;
declare function omit(schema: $ZodObject, mask: object): any;
declare function extend(schema: $ZodObject, shape: $ZodShape): any;
declare function safeExtend(schema: $ZodObject, shape: $ZodShape): any;
declare function merge(a: $ZodObject, b: $ZodObject): any;
declare function partial(Class: SchemaClass<$ZodOptional> | null, schema: $ZodObject, mask: object | undefined): any;
declare function required(Class: SchemaClass<$ZodNonOptional>, schema: $ZodObject, mask: object | undefined): any;
type Constructor<T, Def extends any[] = any[]> = new (...args: Def) => T;
declare function aborted(x: ParsePayload, startIndex?: number): boolean;
declare function explicitlyAborted(x: ParsePayload, startIndex?: number): boolean;
declare function prefixIssues(path: PropertyKey, issues: $ZodRawIssue[]): $ZodRawIssue[];
declare function unwrapMessage(message: string | {
  message: string;
} | undefined | null): string | undefined;
declare function finalizeIssue(iss: $ZodRawIssue, ctx: ParseContextInternal | undefined, config: $ZodConfig): $ZodIssue;
declare function getSizableOrigin(input: any): "set" | "map" | "file" | "unknown";
declare function getLengthableOrigin(input: any): "array" | "string" | "unknown";
declare function parsedType(data: unknown): $ZodInvalidTypeExpected;
declare function issue(_iss: string, input: any, inst: any): $ZodRawIssue;
declare function issue(_iss: $ZodRawIssue): $ZodRawIssue;
declare function cleanEnum(obj: Record<string, EnumValue>): EnumValue[];
declare function base64ToUint8Array(base64: string): InstanceType<typeof Uint8Array>;
declare function uint8ArrayToBase64(bytes: Uint8Array): string;
declare function base64urlToUint8Array(base64url: string): InstanceType<typeof Uint8Array>;
declare function uint8ArrayToBase64url(bytes: Uint8Array): string;
declare function hexToUint8Array(hex: string): InstanceType<typeof Uint8Array>;
declare function uint8ArrayToHex(bytes: Uint8Array): string;
declare abstract class Class {
  constructor(..._args: any[]);
}
//#endregion
//#region node_modules/zod/v4/core/versions.d.cts
declare const version: {
  readonly major: 4;
  readonly minor: 4;
  readonly patch: number;
};
//#endregion
//#region node_modules/zod/v4/core/schemas.d.cts
interface ParseContext<T extends $ZodIssueBase = never> {
  /** Customize error messages. */
  readonly error?: $ZodErrorMap<T>;
  /** Include the `input` field in issue objects. Default `false`. */
  readonly reportInput?: boolean;
  /** Skip eval-based fast path. Default `false`. */
  readonly jitless?: boolean;
}
/** @internal */
interface ParseContextInternal<T extends $ZodIssueBase = never> extends ParseContext<T> {
  readonly async?: boolean | undefined;
  readonly direction?: "forward" | "backward";
  readonly skipChecks?: boolean;
}
interface ParsePayload<T = unknown> {
  value: T;
  issues: $ZodRawIssue[];
  /** A way to mark a whole payload as aborted. Used in codecs/pipes. */
  aborted?: boolean;
  /** @internal Marks a value as a fallback that an outer wrapper (e.g.
   * $ZodOptional) may override with its own interpretation when input was
   * undefined. Set by $ZodCatch when catchValue substitutes and by every
   * $ZodTransform invocation. */
  fallback?: boolean | undefined;
}
type CheckFn<T> = (input: ParsePayload<T>) => MaybeAsync<void>;
interface $ZodTypeDef {
  type: "string" | "number" | "int" | "boolean" | "bigint" | "symbol" | "null" | "undefined" | "void" | "never" | "any" | "unknown" | "date" | "object" | "record" | "file" | "array" | "tuple" | "union" | "intersection" | "map" | "set" | "enum" | "literal" | "nullable" | "optional" | "nonoptional" | "success" | "transform" | "default" | "prefault" | "catch" | "nan" | "pipe" | "readonly" | "template_literal" | "promise" | "lazy" | "function" | "custom";
  error?: $ZodErrorMap<never> | undefined;
  checks?: $ZodCheck<never>[];
}
interface _$ZodTypeInternals {
  /** The `@zod/core` version of this schema */
  version: typeof version;
  /** Schema definition. */
  def: $ZodTypeDef;
  /** @internal Randomly generated ID for this schema. */
  /** @internal List of deferred initializers. */
  deferred: AnyFunc[] | undefined;
  /** @internal Parses input and runs all checks (refinements). */
  run(payload: ParsePayload<any>, ctx: ParseContextInternal): MaybeAsync<ParsePayload>;
  /** @internal Parses input, doesn't run checks. */
  parse(payload: ParsePayload<any>, ctx: ParseContextInternal): MaybeAsync<ParsePayload>;
  /** @internal  Stores identifiers for the set of traits implemented by this schema. */
  traits: Set<string>;
  /** @internal Indicates that a schema output type should be considered optional inside objects.
   * @default Required
   */
  /** @internal */
  optin?: "optional" | undefined;
  /** @internal */
  optout?: "optional" | undefined;
  /** @internal The set of literal values that will pass validation. Must be an exhaustive set. Used to determine optionality in z.record().
   *
   * Defined on: enum, const, literal, null, undefined
   * Passthrough: optional, nullable, branded, default, catch, pipe
   * Todo: unions?
   */
  values?: PrimitiveSet | undefined;
  /** Default value bubbled up from  */
  /** @internal A set of literal discriminators used for the fast path in discriminated unions. */
  propValues?: PropValues | undefined;
  /** @internal This flag indicates that a schema validation can be represented with a regular expression. Used to determine allowable schemas in z.templateLiteral(). */
  pattern: RegExp | undefined;
  /** @internal The constructor function of this schema. */
  constr: new (def: any) => $ZodType;
  /** @internal A catchall object for bag metadata related to this schema. Commonly modified by checks using `onattach`. */
  bag: Record<string, unknown>;
  /** @internal The set of issues this schema might throw during type checking. */
  isst: $ZodIssueBase;
  /** @internal Subject to change, not a public API. */
  processJSONSchema?: ((ctx: ToJSONSchemaContext, json: BaseSchema, params: ProcessParams) => void) | undefined;
  /** An optional method used to override `toJSONSchema` logic. */
  toJSONSchema?: () => unknown;
  /** @internal The parent of this schema. Only set during certain clone operations. */
  parent?: $ZodType | undefined;
}
/** @internal */
interface $ZodTypeInternals<out O = unknown, out I = unknown> extends _$ZodTypeInternals {
  /** @internal The inferred output type */
  output: O;
  /** @internal The inferred input type */
  input: I;
}
type $ZodStandardSchema<T> = StandardSchemaV1.Props<input<T>, output<T>>;
type SomeType = {
  _zod: _$ZodTypeInternals;
};
interface $ZodType<O = unknown, I = unknown, Internals extends $ZodTypeInternals<O, I> = $ZodTypeInternals<O, I>> {
  _zod: Internals;
  "~standard": $ZodStandardSchema<this>;
}
interface _$ZodType<T extends $ZodTypeInternals = $ZodTypeInternals> extends $ZodType<T["output"], T["input"], T> {}
declare const $ZodType: $constructor<$ZodType>;
interface $ZodStringDef extends $ZodTypeDef {
  type: "string";
  coerce?: boolean;
  checks?: $ZodCheck<string>[];
}
interface $ZodStringInternals<Input> extends $ZodTypeInternals<string, Input> {
  def: $ZodStringDef;
  /** @deprecated Internal API, use with caution (not deprecated) */
  pattern: RegExp;
  /** @deprecated Internal API, use with caution (not deprecated) */
  isst: $ZodIssueInvalidType;
  bag: LoosePartial<{
    minimum: number;
    maximum: number;
    patterns: Set<RegExp>;
    format: string;
    contentEncoding: string;
  }>;
}
interface $ZodString<Input = unknown> extends _$ZodType<$ZodStringInternals<Input>> {}
declare const $ZodString: $constructor<$ZodString>;
interface $ZodStringFormatDef<Format extends string = string> extends $ZodStringDef, $ZodCheckStringFormatDef<Format> {}
interface $ZodStringFormatInternals<Format extends string = string> extends $ZodStringInternals<string>, $ZodCheckStringFormatInternals {
  def: $ZodStringFormatDef<Format>;
}
interface $ZodStringFormat<Format extends string = string> extends $ZodType {
  _zod: $ZodStringFormatInternals<Format>;
}
declare const $ZodStringFormat: $constructor<$ZodStringFormat>;
interface $ZodGUIDDef extends $ZodStringFormatDef<"guid"> {}
interface $ZodGUIDInternals extends $ZodStringFormatInternals<"guid"> {}
interface $ZodGUID extends $ZodType {
  _zod: $ZodGUIDInternals;
}
declare const $ZodGUID: $constructor<$ZodGUID>;
interface $ZodUUIDDef extends $ZodStringFormatDef<"uuid"> {
  version?: "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7" | "v8";
}
interface $ZodUUIDInternals extends $ZodStringFormatInternals<"uuid"> {
  def: $ZodUUIDDef;
}
interface $ZodUUID extends $ZodType {
  _zod: $ZodUUIDInternals;
}
declare const $ZodUUID: $constructor<$ZodUUID>;
interface $ZodEmailDef extends $ZodStringFormatDef<"email"> {}
interface $ZodEmailInternals extends $ZodStringFormatInternals<"email"> {}
interface $ZodEmail extends $ZodType {
  _zod: $ZodEmailInternals;
}
declare const $ZodEmail: $constructor<$ZodEmail>;
interface $ZodURLDef extends $ZodStringFormatDef<"url"> {
  hostname?: RegExp | undefined;
  protocol?: RegExp | undefined;
  normalize?: boolean | undefined;
}
interface $ZodURLInternals extends $ZodStringFormatInternals<"url"> {
  def: $ZodURLDef;
}
interface $ZodURL extends $ZodType {
  _zod: $ZodURLInternals;
}
declare const $ZodURL: $constructor<$ZodURL>;
interface $ZodEmojiDef extends $ZodStringFormatDef<"emoji"> {}
interface $ZodEmojiInternals extends $ZodStringFormatInternals<"emoji"> {}
interface $ZodEmoji extends $ZodType {
  _zod: $ZodEmojiInternals;
}
declare const $ZodEmoji: $constructor<$ZodEmoji>;
interface $ZodNanoIDDef extends $ZodStringFormatDef<"nanoid"> {}
interface $ZodNanoIDInternals extends $ZodStringFormatInternals<"nanoid"> {}
interface $ZodNanoID extends $ZodType {
  _zod: $ZodNanoIDInternals;
}
declare const $ZodNanoID: $constructor<$ZodNanoID>;
/**
 * @deprecated CUID v1 is deprecated by its authors due to information leakage
 * (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
 * See https://github.com/paralleldrive/cuid.
 */
interface $ZodCUIDDef extends $ZodStringFormatDef<"cuid"> {}
/**
 * @deprecated CUID v1 is deprecated by its authors due to information leakage
 * (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
 * See https://github.com/paralleldrive/cuid.
 */
interface $ZodCUIDInternals extends $ZodStringFormatInternals<"cuid"> {}
/**
 * @deprecated CUID v1 is deprecated by its authors due to information leakage
 * (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
 * See https://github.com/paralleldrive/cuid.
 */
interface $ZodCUID extends $ZodType {
  _zod: $ZodCUIDInternals;
}
/**
 * @deprecated CUID v1 is deprecated by its authors due to information leakage
 * (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
 * See https://github.com/paralleldrive/cuid.
 */
declare const $ZodCUID: $constructor<$ZodCUID>;
interface $ZodCUID2Def extends $ZodStringFormatDef<"cuid2"> {}
interface $ZodCUID2Internals extends $ZodStringFormatInternals<"cuid2"> {}
interface $ZodCUID2 extends $ZodType {
  _zod: $ZodCUID2Internals;
}
declare const $ZodCUID2: $constructor<$ZodCUID2>;
interface $ZodULIDDef extends $ZodStringFormatDef<"ulid"> {}
interface $ZodULIDInternals extends $ZodStringFormatInternals<"ulid"> {}
interface $ZodULID extends $ZodType {
  _zod: $ZodULIDInternals;
}
declare const $ZodULID: $constructor<$ZodULID>;
interface $ZodXIDDef extends $ZodStringFormatDef<"xid"> {}
interface $ZodXIDInternals extends $ZodStringFormatInternals<"xid"> {}
interface $ZodXID extends $ZodType {
  _zod: $ZodXIDInternals;
}
declare const $ZodXID: $constructor<$ZodXID>;
interface $ZodKSUIDDef extends $ZodStringFormatDef<"ksuid"> {}
interface $ZodKSUIDInternals extends $ZodStringFormatInternals<"ksuid"> {}
interface $ZodKSUID extends $ZodType {
  _zod: $ZodKSUIDInternals;
}
declare const $ZodKSUID: $constructor<$ZodKSUID>;
interface $ZodISODateTimeDef extends $ZodStringFormatDef<"datetime"> {
  precision: number | null;
  offset: boolean;
  local: boolean;
}
interface $ZodISODateTimeInternals extends $ZodStringFormatInternals {
  def: $ZodISODateTimeDef;
}
interface $ZodISODateTime extends $ZodType {
  _zod: $ZodISODateTimeInternals;
}
declare const $ZodISODateTime: $constructor<$ZodISODateTime>;
interface $ZodISODateDef extends $ZodStringFormatDef<"date"> {}
interface $ZodISODateInternals extends $ZodStringFormatInternals<"date"> {}
interface $ZodISODate extends $ZodType {
  _zod: $ZodISODateInternals;
}
declare const $ZodISODate: $constructor<$ZodISODate>;
interface $ZodISOTimeDef extends $ZodStringFormatDef<"time"> {
  precision?: number | null;
}
interface $ZodISOTimeInternals extends $ZodStringFormatInternals<"time"> {
  def: $ZodISOTimeDef;
}
interface $ZodISOTime extends $ZodType {
  _zod: $ZodISOTimeInternals;
}
declare const $ZodISOTime: $constructor<$ZodISOTime>;
interface $ZodISODurationDef extends $ZodStringFormatDef<"duration"> {}
interface $ZodISODurationInternals extends $ZodStringFormatInternals<"duration"> {}
interface $ZodISODuration extends $ZodType {
  _zod: $ZodISODurationInternals;
}
declare const $ZodISODuration: $constructor<$ZodISODuration>;
interface $ZodIPv4Def extends $ZodStringFormatDef<"ipv4"> {
  version?: "v4";
}
interface $ZodIPv4Internals extends $ZodStringFormatInternals<"ipv4"> {
  def: $ZodIPv4Def;
}
interface $ZodIPv4 extends $ZodType {
  _zod: $ZodIPv4Internals;
}
declare const $ZodIPv4: $constructor<$ZodIPv4>;
interface $ZodIPv6Def extends $ZodStringFormatDef<"ipv6"> {
  version?: "v6";
}
interface $ZodIPv6Internals extends $ZodStringFormatInternals<"ipv6"> {
  def: $ZodIPv6Def;
}
interface $ZodIPv6 extends $ZodType {
  _zod: $ZodIPv6Internals;
}
declare const $ZodIPv6: $constructor<$ZodIPv6>;
interface $ZodMACDef extends $ZodStringFormatDef<"mac"> {
  delimiter?: string;
}
interface $ZodMACInternals extends $ZodStringFormatInternals<"mac"> {
  def: $ZodMACDef;
}
interface $ZodMAC extends $ZodType {
  _zod: $ZodMACInternals;
}
declare const $ZodMAC: $constructor<$ZodMAC>;
interface $ZodCIDRv4Def extends $ZodStringFormatDef<"cidrv4"> {
  version?: "v4";
}
interface $ZodCIDRv4Internals extends $ZodStringFormatInternals<"cidrv4"> {
  def: $ZodCIDRv4Def;
}
interface $ZodCIDRv4 extends $ZodType {
  _zod: $ZodCIDRv4Internals;
}
declare const $ZodCIDRv4: $constructor<$ZodCIDRv4>;
interface $ZodCIDRv6Def extends $ZodStringFormatDef<"cidrv6"> {
  version?: "v6";
}
interface $ZodCIDRv6Internals extends $ZodStringFormatInternals<"cidrv6"> {
  def: $ZodCIDRv6Def;
}
interface $ZodCIDRv6 extends $ZodType {
  _zod: $ZodCIDRv6Internals;
}
declare const $ZodCIDRv6: $constructor<$ZodCIDRv6>;
declare function isValidBase64(data: string): boolean;
interface $ZodBase64Def extends $ZodStringFormatDef<"base64"> {}
interface $ZodBase64Internals extends $ZodStringFormatInternals<"base64"> {}
interface $ZodBase64 extends $ZodType {
  _zod: $ZodBase64Internals;
}
declare const $ZodBase64: $constructor<$ZodBase64>;
declare function isValidBase64URL(data: string): boolean;
interface $ZodBase64URLDef extends $ZodStringFormatDef<"base64url"> {}
interface $ZodBase64URLInternals extends $ZodStringFormatInternals<"base64url"> {}
interface $ZodBase64URL extends $ZodType {
  _zod: $ZodBase64URLInternals;
}
declare const $ZodBase64URL: $constructor<$ZodBase64URL>;
interface $ZodE164Def extends $ZodStringFormatDef<"e164"> {}
interface $ZodE164Internals extends $ZodStringFormatInternals<"e164"> {}
interface $ZodE164 extends $ZodType {
  _zod: $ZodE164Internals;
}
declare const $ZodE164: $constructor<$ZodE164>;
declare function isValidJWT(token: string, algorithm?: JWTAlgorithm | null): boolean;
interface $ZodJWTDef extends $ZodStringFormatDef<"jwt"> {
  alg?: JWTAlgorithm | undefined;
}
interface $ZodJWTInternals extends $ZodStringFormatInternals<"jwt"> {
  def: $ZodJWTDef;
}
interface $ZodJWT extends $ZodType {
  _zod: $ZodJWTInternals;
}
declare const $ZodJWT: $constructor<$ZodJWT>;
interface $ZodCustomStringFormatDef<Format extends string = string> extends $ZodStringFormatDef<Format> {
  fn: (val: string) => unknown;
}
interface $ZodCustomStringFormatInternals<Format extends string = string> extends $ZodStringFormatInternals<Format> {
  def: $ZodCustomStringFormatDef<Format>;
}
interface $ZodCustomStringFormat<Format extends string = string> extends $ZodStringFormat<Format> {
  _zod: $ZodCustomStringFormatInternals<Format>;
}
declare const $ZodCustomStringFormat: $constructor<$ZodCustomStringFormat>;
interface $ZodNumberDef extends $ZodTypeDef {
  type: "number";
  coerce?: boolean;
}
interface $ZodNumberInternals<Input = unknown> extends $ZodTypeInternals<number, Input> {
  def: $ZodNumberDef;
  /** @deprecated Internal API, use with caution (not deprecated) */
  pattern: RegExp;
  /** @deprecated Internal API, use with caution (not deprecated) */
  isst: $ZodIssueInvalidType;
  bag: LoosePartial<{
    minimum: number;
    maximum: number;
    exclusiveMinimum: number;
    exclusiveMaximum: number;
    format: string;
    pattern: RegExp;
  }>;
}
interface $ZodNumber<Input = unknown> extends $ZodType {
  _zod: $ZodNumberInternals<Input>;
}
declare const $ZodNumber: $constructor<$ZodNumber>;
interface $ZodNumberFormatDef extends $ZodNumberDef, $ZodCheckNumberFormatDef {}
interface $ZodNumberFormatInternals extends $ZodNumberInternals<number>, $ZodCheckNumberFormatInternals {
  def: $ZodNumberFormatDef;
  isst: $ZodIssueInvalidType;
}
interface $ZodNumberFormat extends $ZodType {
  _zod: $ZodNumberFormatInternals;
}
declare const $ZodNumberFormat: $constructor<$ZodNumberFormat>;
interface $ZodBooleanDef extends $ZodTypeDef {
  type: "boolean";
  coerce?: boolean;
  checks?: $ZodCheck<boolean>[];
}
interface $ZodBooleanInternals<T = unknown> extends $ZodTypeInternals<boolean, T> {
  pattern: RegExp;
  def: $ZodBooleanDef;
  isst: $ZodIssueInvalidType;
}
interface $ZodBoolean<T = unknown> extends $ZodType {
  _zod: $ZodBooleanInternals<T>;
}
declare const $ZodBoolean: $constructor<$ZodBoolean>;
interface $ZodBigIntDef extends $ZodTypeDef {
  type: "bigint";
  coerce?: boolean;
}
interface $ZodBigIntInternals<T = unknown> extends $ZodTypeInternals<bigint, T> {
  pattern: RegExp;
  /** @internal Internal API, use with caution */
  def: $ZodBigIntDef;
  isst: $ZodIssueInvalidType;
  bag: LoosePartial<{
    minimum: bigint;
    maximum: bigint;
    format: string;
  }>;
}
interface $ZodBigInt<T = unknown> extends $ZodType {
  _zod: $ZodBigIntInternals<T>;
}
declare const $ZodBigInt: $constructor<$ZodBigInt>;
interface $ZodBigIntFormatDef extends $ZodBigIntDef, $ZodCheckBigIntFormatDef {
  check: "bigint_format";
}
interface $ZodBigIntFormatInternals extends $ZodBigIntInternals<bigint>, $ZodCheckBigIntFormatInternals {
  def: $ZodBigIntFormatDef;
}
interface $ZodBigIntFormat extends $ZodType {
  _zod: $ZodBigIntFormatInternals;
}
declare const $ZodBigIntFormat: $constructor<$ZodBigIntFormat>;
interface $ZodSymbolDef extends $ZodTypeDef {
  type: "symbol";
}
interface $ZodSymbolInternals extends $ZodTypeInternals<symbol, symbol> {
  def: $ZodSymbolDef;
  isst: $ZodIssueInvalidType;
}
interface $ZodSymbol extends $ZodType {
  _zod: $ZodSymbolInternals;
}
declare const $ZodSymbol: $constructor<$ZodSymbol>;
interface $ZodUndefinedDef extends $ZodTypeDef {
  type: "undefined";
}
interface $ZodUndefinedInternals extends $ZodTypeInternals<undefined, undefined> {
  pattern: RegExp;
  def: $ZodUndefinedDef;
  values: PrimitiveSet;
  isst: $ZodIssueInvalidType;
}
interface $ZodUndefined extends $ZodType {
  _zod: $ZodUndefinedInternals;
}
declare const $ZodUndefined: $constructor<$ZodUndefined>;
interface $ZodNullDef extends $ZodTypeDef {
  type: "null";
}
interface $ZodNullInternals extends $ZodTypeInternals<null, null> {
  pattern: RegExp;
  def: $ZodNullDef;
  values: PrimitiveSet;
  isst: $ZodIssueInvalidType;
}
interface $ZodNull extends $ZodType {
  _zod: $ZodNullInternals;
}
declare const $ZodNull: $constructor<$ZodNull>;
interface $ZodAnyDef extends $ZodTypeDef {
  type: "any";
}
interface $ZodAnyInternals extends $ZodTypeInternals<any, any> {
  def: $ZodAnyDef;
  isst: never;
}
interface $ZodAny extends $ZodType {
  _zod: $ZodAnyInternals;
}
declare const $ZodAny: $constructor<$ZodAny>;
interface $ZodUnknownDef extends $ZodTypeDef {
  type: "unknown";
}
interface $ZodUnknownInternals extends $ZodTypeInternals<unknown, unknown> {
  def: $ZodUnknownDef;
  isst: never;
}
interface $ZodUnknown extends $ZodType {
  _zod: $ZodUnknownInternals;
}
declare const $ZodUnknown: $constructor<$ZodUnknown>;
interface $ZodNeverDef extends $ZodTypeDef {
  type: "never";
}
interface $ZodNeverInternals extends $ZodTypeInternals<never, never> {
  def: $ZodNeverDef;
  isst: $ZodIssueInvalidType;
}
interface $ZodNever extends $ZodType {
  _zod: $ZodNeverInternals;
}
declare const $ZodNever: $constructor<$ZodNever>;
interface $ZodVoidDef extends $ZodTypeDef {
  type: "void";
}
interface $ZodVoidInternals extends $ZodTypeInternals<void, void> {
  def: $ZodVoidDef;
  isst: $ZodIssueInvalidType;
}
interface $ZodVoid extends $ZodType {
  _zod: $ZodVoidInternals;
}
declare const $ZodVoid: $constructor<$ZodVoid>;
interface $ZodDateDef extends $ZodTypeDef {
  type: "date";
  coerce?: boolean;
}
interface $ZodDateInternals<T = unknown> extends $ZodTypeInternals<Date, T> {
  def: $ZodDateDef;
  isst: $ZodIssueInvalidType;
  bag: LoosePartial<{
    minimum: Date;
    maximum: Date;
    format: string;
  }>;
}
interface $ZodDate<T = unknown> extends $ZodType {
  _zod: $ZodDateInternals<T>;
}
declare const $ZodDate: $constructor<$ZodDate>;
interface $ZodArrayDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "array";
  element: T;
}
interface $ZodArrayInternals<T extends SomeType = $ZodType> extends _$ZodTypeInternals {
  def: $ZodArrayDef<T>;
  isst: $ZodIssueInvalidType;
  output: output<T>[];
  input: input<T>[];
}
interface $ZodArray<T extends SomeType = $ZodType> extends $ZodType<any, any, $ZodArrayInternals<T>> {}
declare const $ZodArray: $constructor<$ZodArray>;
type OptionalOutSchema = {
  _zod: {
    optout: "optional";
  };
};
type OptionalInSchema = {
  _zod: {
    optin: "optional";
  };
};
type $InferObjectOutput<T extends $ZodLooseShape, Extra extends Record<string, unknown>> = string extends keyof T ? IsAny<T[keyof T]> extends true ? Record<string, unknown> : Record<string, output<T[keyof T]>> : keyof (T & Extra) extends never ? Record<string, never> : Prettify<{ -readonly [k in keyof T as T[k] extends OptionalOutSchema ? never : k]: T[k]["_zod"]["output"] } & { -readonly [k in keyof T as T[k] extends OptionalOutSchema ? k : never]?: T[k]["_zod"]["output"] } & Extra>;
type $InferObjectInput<T extends $ZodLooseShape, Extra extends Record<string, unknown>> = string extends keyof T ? IsAny<T[keyof T]> extends true ? Record<string, unknown> : Record<string, input<T[keyof T]>> : keyof (T & Extra) extends never ? Record<string, never> : Prettify<{ -readonly [k in keyof T as T[k] extends OptionalInSchema ? never : k]: T[k]["_zod"]["input"] } & { -readonly [k in keyof T as T[k] extends OptionalInSchema ? k : never]?: T[k]["_zod"]["input"] } & Extra>;
type $ZodObjectConfig = {
  out: Record<string, unknown>;
  in: Record<string, unknown>;
};
type $loose = {
  out: Record<string, unknown>;
  in: Record<string, unknown>;
};
type $strict = {
  out: {};
  in: {};
};
type $strip = {
  out: {};
  in: {};
};
type $catchall<T extends SomeType> = {
  out: {
    [k: string]: output<T>;
  };
  in: {
    [k: string]: input<T>;
  };
};
type $ZodShape = Readonly<{
  [k: string]: $ZodType;
}>;
interface $ZodObjectDef<Shape extends $ZodShape = $ZodShape> extends $ZodTypeDef {
  type: "object";
  shape: Shape;
  catchall?: $ZodType | undefined;
}
interface $ZodObjectInternals< /** @ts-ignore Cast variance */out Shape extends $ZodShape = $ZodShape, out Config extends $ZodObjectConfig = $ZodObjectConfig> extends _$ZodTypeInternals {
  def: $ZodObjectDef<Shape>;
  config: Config;
  isst: $ZodIssueInvalidType | $ZodIssueUnrecognizedKeys;
  propValues: PropValues;
  output: $InferObjectOutput<Shape, Config["out"]>;
  input: $InferObjectInput<Shape, Config["in"]>;
  optin?: "optional" | undefined;
  optout?: "optional" | undefined;
}
type $ZodLooseShape = Record<string, any>;
interface $ZodObject< /** @ts-ignore Cast variance */out Shape extends Readonly<$ZodShape> = Readonly<$ZodShape>, out Params extends $ZodObjectConfig = $ZodObjectConfig> extends $ZodType<any, any, $ZodObjectInternals<Shape, Params>> {}
declare const $ZodObject: $constructor<$ZodObject>;
declare const $ZodObjectJIT: $constructor<$ZodObject>;
type $InferUnionOutput<T extends SomeType> = T extends any ? output<T> : never;
type $InferUnionInput<T extends SomeType> = T extends any ? input<T> : never;
interface $ZodUnionDef<Options extends readonly SomeType[] = readonly $ZodType[]> extends $ZodTypeDef {
  type: "union";
  options: Options;
  inclusive?: boolean;
}
type IsOptionalIn<T extends SomeType> = T extends OptionalInSchema ? true : false;
type IsOptionalOut<T extends SomeType> = T extends OptionalOutSchema ? true : false;
interface $ZodUnionInternals<T extends readonly SomeType[] = readonly $ZodType[]> extends _$ZodTypeInternals {
  def: $ZodUnionDef<T>;
  isst: $ZodIssueInvalidUnion;
  pattern: T[number]["_zod"]["pattern"];
  values: T[number]["_zod"]["values"];
  output: $InferUnionOutput<T[number]>;
  input: $InferUnionInput<T[number]>;
  optin: IsOptionalIn<T[number]> extends false ? "optional" | undefined : "optional";
  optout: IsOptionalOut<T[number]> extends false ? "optional" | undefined : "optional";
}
interface $ZodUnion<T extends readonly SomeType[] = readonly $ZodType[]> extends $ZodType<any, any, $ZodUnionInternals<T>> {
  _zod: $ZodUnionInternals<T>;
}
declare const $ZodUnion: $constructor<$ZodUnion>;
interface $ZodXorInternals<T extends readonly SomeType[] = readonly $ZodType[]> extends $ZodUnionInternals<T> {}
interface $ZodXor<T extends readonly SomeType[] = readonly $ZodType[]> extends $ZodType<any, any, $ZodXorInternals<T>> {
  _zod: $ZodXorInternals<T>;
}
declare const $ZodXor: $constructor<$ZodXor>;
interface $ZodDiscriminatedUnionDef<Options extends readonly SomeType[] = readonly $ZodType[], Disc extends string = string> extends $ZodUnionDef<Options> {
  discriminator: Disc;
  unionFallback?: boolean;
}
interface $ZodDiscriminatedUnionInternals<Options extends readonly SomeType[] = readonly $ZodType[], Disc extends string = string> extends $ZodUnionInternals<Options> {
  def: $ZodDiscriminatedUnionDef<Options, Disc>;
  propValues: PropValues;
}
interface $ZodDiscriminatedUnion<Options extends readonly SomeType[] = readonly $ZodType[], Disc extends string = string> extends $ZodType {
  _zod: $ZodDiscriminatedUnionInternals<Options, Disc>;
}
declare const $ZodDiscriminatedUnion: $constructor<$ZodDiscriminatedUnion>;
interface $ZodIntersectionDef<Left extends SomeType = $ZodType, Right extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "intersection";
  left: Left;
  right: Right;
}
interface $ZodIntersectionInternals<A extends SomeType = $ZodType, B extends SomeType = $ZodType> extends _$ZodTypeInternals {
  def: $ZodIntersectionDef<A, B>;
  isst: never;
  optin: A["_zod"]["optin"] | B["_zod"]["optin"];
  optout: A["_zod"]["optout"] | B["_zod"]["optout"];
  output: output<A> & output<B>;
  input: input<A> & input<B>;
}
interface $ZodIntersection<A extends SomeType = $ZodType, B extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodIntersectionInternals<A, B>;
}
declare const $ZodIntersection: $constructor<$ZodIntersection>;
interface $ZodTupleDef<T extends TupleItems = readonly $ZodType[], Rest extends SomeType | null = $ZodType | null> extends $ZodTypeDef {
  type: "tuple";
  items: T;
  rest: Rest;
}
type $InferTupleInputType<T extends TupleItems, Rest extends SomeType | null> = [...TupleInputTypeWithOptionals<T>, ...(Rest extends SomeType ? input<Rest>[] : [])];
type TupleInputTypeNoOptionals<T extends TupleItems> = { [k in keyof T]: input<T[k]> };
type TupleInputTypeWithOptionals<T extends TupleItems> = T extends readonly [...infer Prefix extends SomeType[], infer Tail extends SomeType] ? Tail["_zod"]["optin"] extends "optional" ? [...TupleInputTypeWithOptionals<Prefix>, input<Tail>?] : TupleInputTypeNoOptionals<T> : [];
type $InferTupleOutputType<T extends TupleItems, Rest extends SomeType | null> = [...TupleOutputTypeWithOptionals<T>, ...(Rest extends SomeType ? output<Rest>[] : [])];
type TupleOutputTypeNoOptionals<T extends TupleItems> = { [k in keyof T]: output<T[k]> };
type TupleOutputTypeWithOptionals<T extends TupleItems> = T extends readonly [...infer Prefix extends SomeType[], infer Tail extends SomeType] ? Tail["_zod"]["optout"] extends "optional" ? [...TupleOutputTypeWithOptionals<Prefix>, output<Tail>?] : TupleOutputTypeNoOptionals<T> : [];
interface $ZodTupleInternals<T extends TupleItems = readonly $ZodType[], Rest extends SomeType | null = $ZodType | null> extends _$ZodTypeInternals {
  def: $ZodTupleDef<T, Rest>;
  isst: $ZodIssueInvalidType | $ZodIssueTooBig<unknown[]> | $ZodIssueTooSmall<unknown[]>;
  output: $InferTupleOutputType<T, Rest>;
  input: $InferTupleInputType<T, Rest>;
}
interface $ZodTuple<T extends TupleItems = readonly $ZodType[], Rest extends SomeType | null = $ZodType | null> extends $ZodType {
  _zod: $ZodTupleInternals<T, Rest>;
}
declare const $ZodTuple: $constructor<$ZodTuple>;
type $ZodRecordKey = $ZodType<string | number | symbol, unknown>;
interface $ZodRecordDef<Key extends $ZodRecordKey = $ZodRecordKey, Value extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "record";
  keyType: Key;
  valueType: Value;
  /** @default "strict" - errors on keys not matching keyType. "loose" passes through non-matching keys unchanged. */
  mode?: "strict" | "loose";
}
type $InferZodRecordOutput<Key extends $ZodRecordKey = $ZodRecordKey, Value extends SomeType = $ZodType> = Key extends $partial ? Partial<Record<output<Key>, output<Value>>> : Record<output<Key>, output<Value>>;
type $InferZodRecordInput<Key extends $ZodRecordKey = $ZodRecordKey, Value extends SomeType = $ZodType> = Key extends $partial ? Partial<Record<input<Key> & PropertyKey, input<Value>>> : Record<input<Key> & PropertyKey, input<Value>>;
interface $ZodRecordInternals<Key extends $ZodRecordKey = $ZodRecordKey, Value extends SomeType = $ZodType> extends $ZodTypeInternals<$InferZodRecordOutput<Key, Value>, $InferZodRecordInput<Key, Value>> {
  def: $ZodRecordDef<Key, Value>;
  isst: $ZodIssueInvalidType | $ZodIssueInvalidKey<Record<PropertyKey, unknown>>;
  optin?: "optional" | undefined;
  optout?: "optional" | undefined;
}
type $partial = {
  "~~partial": true;
};
interface $ZodRecord<Key extends $ZodRecordKey = $ZodRecordKey, Value extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodRecordInternals<Key, Value>;
}
declare const $ZodRecord: $constructor<$ZodRecord>;
interface $ZodMapDef<Key extends SomeType = $ZodType, Value extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "map";
  keyType: Key;
  valueType: Value;
}
interface $ZodMapInternals<Key extends SomeType = $ZodType, Value extends SomeType = $ZodType> extends $ZodTypeInternals<Map<output<Key>, output<Value>>, Map<input<Key>, input<Value>>> {
  def: $ZodMapDef<Key, Value>;
  isst: $ZodIssueInvalidType | $ZodIssueInvalidKey | $ZodIssueInvalidElement<unknown>;
  optin?: "optional" | undefined;
  optout?: "optional" | undefined;
}
interface $ZodMap<Key extends SomeType = $ZodType, Value extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodMapInternals<Key, Value>;
}
declare const $ZodMap: $constructor<$ZodMap>;
interface $ZodSetDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "set";
  valueType: T;
}
interface $ZodSetInternals<T extends SomeType = $ZodType> extends $ZodTypeInternals<Set<output<T>>, Set<input<T>>> {
  def: $ZodSetDef<T>;
  isst: $ZodIssueInvalidType;
  optin?: "optional" | undefined;
  optout?: "optional" | undefined;
}
interface $ZodSet<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodSetInternals<T>;
}
declare const $ZodSet: $constructor<$ZodSet>;
type $InferEnumOutput<T extends EnumLike> = T[keyof T] & {};
type $InferEnumInput<T extends EnumLike> = T[keyof T] & {};
interface $ZodEnumDef<T extends EnumLike = EnumLike> extends $ZodTypeDef {
  type: "enum";
  entries: T;
}
interface $ZodEnumInternals< /** @ts-ignore Cast variance */out T extends EnumLike = EnumLike> extends $ZodTypeInternals<$InferEnumOutput<T>, $InferEnumInput<T>> {
  def: $ZodEnumDef<T>;
  /** @deprecated Internal API, use with caution (not deprecated) */
  values: PrimitiveSet;
  /** @deprecated Internal API, use with caution (not deprecated) */
  pattern: RegExp;
  isst: $ZodIssueInvalidValue;
}
interface $ZodEnum<T extends EnumLike = EnumLike> extends $ZodType {
  _zod: $ZodEnumInternals<T>;
}
declare const $ZodEnum: $constructor<$ZodEnum>;
interface $ZodLiteralDef<T extends Literal> extends $ZodTypeDef {
  type: "literal";
  values: T[];
}
interface $ZodLiteralInternals<T extends Literal = Literal> extends $ZodTypeInternals<T, T> {
  def: $ZodLiteralDef<T>;
  values: Set<T>;
  pattern: RegExp;
  isst: $ZodIssueInvalidValue;
}
interface $ZodLiteral<T extends Literal = Literal> extends $ZodType {
  _zod: $ZodLiteralInternals<T>;
}
declare const $ZodLiteral: $constructor<$ZodLiteral>;
type _File = typeof globalThis extends {
  File: infer F extends new (...args: any[]) => any;
} ? InstanceType<F> : {};
/** Do not reference this directly. */
interface File extends _File {
  readonly type: string;
  readonly size: number;
}
interface $ZodFileDef extends $ZodTypeDef {
  type: "file";
}
interface $ZodFileInternals extends $ZodTypeInternals<File, File> {
  def: $ZodFileDef;
  isst: $ZodIssueInvalidType;
  bag: LoosePartial<{
    minimum: number;
    maximum: number;
    mime: MimeTypes[];
  }>;
}
interface $ZodFile extends $ZodType {
  _zod: $ZodFileInternals;
}
declare const $ZodFile: $constructor<$ZodFile>;
interface $ZodTransformDef extends $ZodTypeDef {
  type: "transform";
  transform: (input: unknown, payload: ParsePayload<unknown>) => MaybeAsync<unknown>;
}
interface $ZodTransformInternals<O = unknown, I = unknown> extends $ZodTypeInternals<O, I> {
  def: $ZodTransformDef;
  isst: never;
}
interface $ZodTransform<O = unknown, I = unknown> extends $ZodType {
  _zod: $ZodTransformInternals<O, I>;
}
declare const $ZodTransform: $constructor<$ZodTransform>;
interface $ZodOptionalDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "optional";
  innerType: T;
}
interface $ZodOptionalInternals<T extends SomeType = $ZodType> extends $ZodTypeInternals<output<T> | undefined, input<T> | undefined> {
  def: $ZodOptionalDef<T>;
  optin: "optional";
  optout: "optional";
  isst: never;
  values: T["_zod"]["values"];
  pattern: T["_zod"]["pattern"];
}
interface $ZodOptional<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodOptionalInternals<T>;
}
declare const $ZodOptional: $constructor<$ZodOptional>;
interface $ZodExactOptionalDef<T extends SomeType = $ZodType> extends $ZodOptionalDef<T> {}
interface $ZodExactOptionalInternals<T extends SomeType = $ZodType> extends $ZodOptionalInternals<T> {
  def: $ZodExactOptionalDef<T>;
  output: output<T>;
  input: input<T>;
}
interface $ZodExactOptional<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodExactOptionalInternals<T>;
}
declare const $ZodExactOptional: $constructor<$ZodExactOptional>;
interface $ZodNullableDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "nullable";
  innerType: T;
}
interface $ZodNullableInternals<T extends SomeType = $ZodType> extends $ZodTypeInternals<output<T> | null, input<T> | null> {
  def: $ZodNullableDef<T>;
  optin: T["_zod"]["optin"];
  optout: T["_zod"]["optout"];
  isst: never;
  values: T["_zod"]["values"];
  pattern: T["_zod"]["pattern"];
}
interface $ZodNullable<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodNullableInternals<T>;
}
declare const $ZodNullable: $constructor<$ZodNullable>;
interface $ZodDefaultDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "default";
  innerType: T;
  /** The default value. May be a getter. */
  defaultValue: NoUndefined<output<T>>;
}
interface $ZodDefaultInternals<T extends SomeType = $ZodType> extends $ZodTypeInternals<NoUndefined<output<T>>, input<T> | undefined> {
  def: $ZodDefaultDef<T>;
  optin: "optional";
  optout?: "optional" | undefined;
  isst: never;
  values: T["_zod"]["values"];
}
interface $ZodDefault<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodDefaultInternals<T>;
}
declare const $ZodDefault: $constructor<$ZodDefault>;
interface $ZodPrefaultDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "prefault";
  innerType: T;
  /** The default value. May be a getter. */
  defaultValue: input<T>;
}
interface $ZodPrefaultInternals<T extends SomeType = $ZodType> extends $ZodTypeInternals<NoUndefined<output<T>>, input<T> | undefined> {
  def: $ZodPrefaultDef<T>;
  optin: "optional";
  optout?: "optional" | undefined;
  isst: never;
  values: T["_zod"]["values"];
}
interface $ZodPrefault<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodPrefaultInternals<T>;
}
declare const $ZodPrefault: $constructor<$ZodPrefault>;
interface $ZodNonOptionalDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "nonoptional";
  innerType: T;
}
interface $ZodNonOptionalInternals<T extends SomeType = $ZodType> extends $ZodTypeInternals<NoUndefined<output<T>>, NoUndefined<input<T>>> {
  def: $ZodNonOptionalDef<T>;
  isst: $ZodIssueInvalidType;
  values: T["_zod"]["values"];
  optin: "optional" | undefined;
  optout: "optional" | undefined;
}
interface $ZodNonOptional<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodNonOptionalInternals<T>;
}
declare const $ZodNonOptional: $constructor<$ZodNonOptional>;
interface $ZodSuccessDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "success";
  innerType: T;
}
interface $ZodSuccessInternals<T extends SomeType = $ZodType> extends $ZodTypeInternals<boolean, input<T>> {
  def: $ZodSuccessDef<T>;
  isst: never;
  optin: T["_zod"]["optin"];
  optout: "optional" | undefined;
}
interface $ZodSuccess<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodSuccessInternals<T>;
}
declare const $ZodSuccess: $constructor<$ZodSuccess>;
interface $ZodCatchCtx extends ParsePayload {
  /** @deprecated Use `ctx.issues` */
  error: {
    issues: $ZodIssue[];
  };
  /** @deprecated Use `ctx.value` */
  input: unknown;
}
interface $ZodCatchDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "catch";
  innerType: T;
  catchValue: (ctx: $ZodCatchCtx) => unknown;
}
interface $ZodCatchInternals<T extends SomeType = $ZodType> extends $ZodTypeInternals<output<T>, input<T>> {
  def: $ZodCatchDef<T>;
  optin: T["_zod"]["optin"];
  optout: T["_zod"]["optout"];
  isst: never;
  values: T["_zod"]["values"];
}
interface $ZodCatch<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodCatchInternals<T>;
}
declare const $ZodCatch: $constructor<$ZodCatch>;
interface $ZodNaNDef extends $ZodTypeDef {
  type: "nan";
}
interface $ZodNaNInternals extends $ZodTypeInternals<number, number> {
  def: $ZodNaNDef;
  isst: $ZodIssueInvalidType;
}
interface $ZodNaN extends $ZodType {
  _zod: $ZodNaNInternals;
}
declare const $ZodNaN: $constructor<$ZodNaN>;
interface $ZodPipeDef<A extends SomeType = $ZodType, B extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "pipe";
  in: A;
  out: B;
  /** Only defined inside $ZodCodec instances. */
  transform?: (value: output<A>, payload: ParsePayload<output<A>>) => MaybeAsync<input<B>>;
  /** Only defined inside $ZodCodec instances. */
  reverseTransform?: (value: input<B>, payload: ParsePayload<input<B>>) => MaybeAsync<output<A>>;
}
interface $ZodPipeInternals<A extends SomeType = $ZodType, B extends SomeType = $ZodType> extends $ZodTypeInternals<output<B>, input<A>> {
  def: $ZodPipeDef<A, B>;
  isst: never;
  values: A["_zod"]["values"];
  optin: A["_zod"]["optin"];
  optout: B["_zod"]["optout"];
  propValues: A["_zod"]["propValues"];
}
interface $ZodPipe<A extends SomeType = $ZodType, B extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodPipeInternals<A, B>;
}
declare const $ZodPipe: $constructor<$ZodPipe>;
interface $ZodCodecDef<A extends SomeType = $ZodType, B extends SomeType = $ZodType> extends $ZodPipeDef<A, B> {
  transform: (value: output<A>, payload: ParsePayload<output<A>>) => MaybeAsync<input<B>>;
  reverseTransform: (value: input<B>, payload: ParsePayload<input<B>>) => MaybeAsync<output<A>>;
}
interface $ZodCodecInternals<A extends SomeType = $ZodType, B extends SomeType = $ZodType> extends $ZodTypeInternals<output<B>, input<A>> {
  def: $ZodCodecDef<A, B>;
  isst: never;
  values: A["_zod"]["values"];
  optin: A["_zod"]["optin"];
  optout: B["_zod"]["optout"];
  propValues: A["_zod"]["propValues"];
}
interface $ZodCodec<A extends SomeType = $ZodType, B extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodCodecInternals<A, B>;
}
declare const $ZodCodec: $constructor<$ZodCodec>;
interface $ZodPreprocessDef<B extends SomeType = $ZodType> extends $ZodPipeDef<$ZodTransform, B> {
  in: $ZodTransform;
  out: B;
}
interface $ZodPreprocessInternals<B extends SomeType = $ZodType> extends $ZodPipeInternals<$ZodTransform, B> {
  def: $ZodPreprocessDef<B>;
  optin: B["_zod"]["optin"];
  optout: B["_zod"]["optout"];
}
interface $ZodPreprocess<B extends SomeType = $ZodType> extends $ZodPipe<$ZodTransform, B> {
  _zod: $ZodPreprocessInternals<B>;
}
declare const $ZodPreprocess: $constructor<$ZodPreprocess>;
interface $ZodReadonlyDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "readonly";
  innerType: T;
}
interface $ZodReadonlyInternals<T extends SomeType = $ZodType> extends $ZodTypeInternals<MakeReadonly<output<T>>, MakeReadonly<input<T>>> {
  def: $ZodReadonlyDef<T>;
  optin: T["_zod"]["optin"];
  optout: T["_zod"]["optout"];
  isst: never;
  propValues: T["_zod"]["propValues"];
  values: T["_zod"]["values"];
}
interface $ZodReadonly<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodReadonlyInternals<T>;
}
declare const $ZodReadonly: $constructor<$ZodReadonly>;
interface $ZodTemplateLiteralDef extends $ZodTypeDef {
  type: "template_literal";
  parts: $ZodTemplateLiteralPart[];
  format?: string | undefined;
}
interface $ZodTemplateLiteralInternals<Template extends string = string> extends $ZodTypeInternals<Template, Template> {
  pattern: RegExp;
  def: $ZodTemplateLiteralDef;
  isst: $ZodIssueInvalidType;
}
interface $ZodTemplateLiteral<Template extends string = string> extends $ZodType {
  _zod: $ZodTemplateLiteralInternals<Template>;
}
type LiteralPart = Exclude<Literal, symbol>;
interface SchemaPartInternals extends $ZodTypeInternals<LiteralPart, LiteralPart> {
  pattern: RegExp;
}
interface SchemaPart extends $ZodType {
  _zod: SchemaPartInternals;
}
type $ZodTemplateLiteralPart = LiteralPart | SchemaPart;
type UndefinedToEmptyString<T> = T extends undefined ? "" : T;
type AppendToTemplateLiteral<Template extends string, Suffix extends LiteralPart | $ZodType> = Suffix extends LiteralPart ? `${Template}${UndefinedToEmptyString<Suffix>}` : Suffix extends $ZodType ? `${Template}${output<Suffix> extends infer T extends LiteralPart ? UndefinedToEmptyString<T> : never}` : never;
type ConcatenateTupleOfStrings<T extends string[]> = T extends [infer First extends string, ...infer Rest extends string[]] ? Rest extends string[] ? First extends "" ? ConcatenateTupleOfStrings<Rest> : `${First}${ConcatenateTupleOfStrings<Rest>}` : never : "";
type ConvertPartsToStringTuple<Parts extends $ZodTemplateLiteralPart[]> = { [K in keyof Parts]: Parts[K] extends LiteralPart ? `${UndefinedToEmptyString<Parts[K]>}` : Parts[K] extends $ZodType ? `${output<Parts[K]> extends infer T extends LiteralPart ? UndefinedToEmptyString<T> : never}` : never };
type ToTemplateLiteral<Parts extends $ZodTemplateLiteralPart[]> = ConcatenateTupleOfStrings<ConvertPartsToStringTuple<Parts>>;
type $PartsToTemplateLiteral<Parts extends $ZodTemplateLiteralPart[]> = [] extends Parts ? `` : Parts extends [...infer Rest, infer Last extends $ZodTemplateLiteralPart] ? Rest extends $ZodTemplateLiteralPart[] ? AppendToTemplateLiteral<$PartsToTemplateLiteral<Rest>, Last> : never : never;
declare const $ZodTemplateLiteral: $constructor<$ZodTemplateLiteral>;
type $ZodFunctionArgs = $ZodType<unknown[], unknown[]>;
type $ZodFunctionIn = $ZodFunctionArgs;
type $ZodFunctionOut = $ZodType;
type $InferInnerFunctionType<Args extends $ZodFunctionIn, Returns extends $ZodFunctionOut> = (...args: $ZodFunctionIn extends Args ? never[] : output<Args>) => input<Returns>;
type $InferInnerFunctionTypeAsync<Args extends $ZodFunctionIn, Returns extends $ZodFunctionOut> = (...args: $ZodFunctionIn extends Args ? never[] : output<Args>) => MaybeAsync<input<Returns>>;
type $InferOuterFunctionType<Args extends $ZodFunctionIn, Returns extends $ZodFunctionOut> = (...args: $ZodFunctionIn extends Args ? never[] : input<Args>) => output<Returns>;
type $InferOuterFunctionTypeAsync<Args extends $ZodFunctionIn, Returns extends $ZodFunctionOut> = (...args: $ZodFunctionIn extends Args ? never[] : input<Args>) => Promise<output<Returns>>;
interface $ZodFunctionDef<In extends $ZodFunctionIn = $ZodFunctionIn, Out extends $ZodFunctionOut = $ZodFunctionOut> extends $ZodTypeDef {
  type: "function";
  input: In;
  output: Out;
}
interface $ZodFunctionInternals<Args extends $ZodFunctionIn, Returns extends $ZodFunctionOut> extends $ZodTypeInternals<$InferOuterFunctionType<Args, Returns>, $InferInnerFunctionType<Args, Returns>> {
  def: $ZodFunctionDef<Args, Returns>;
  isst: $ZodIssueInvalidType;
}
interface $ZodFunction<Args extends $ZodFunctionIn = $ZodFunctionIn, Returns extends $ZodFunctionOut = $ZodFunctionOut> extends $ZodType<any, any, $ZodFunctionInternals<Args, Returns>> {
  /** @deprecated */
  _def: $ZodFunctionDef<Args, Returns>;
  _input: $InferInnerFunctionType<Args, Returns>;
  _output: $InferOuterFunctionType<Args, Returns>;
  implement<F extends $InferInnerFunctionType<Args, Returns>>(func: F): (...args: Parameters<this["_output"]>) => ReturnType<F> extends ReturnType<this["_output"]> ? ReturnType<F> : ReturnType<this["_output"]>;
  implementAsync<F extends $InferInnerFunctionTypeAsync<Args, Returns>>(func: F): F extends $InferOuterFunctionTypeAsync<Args, Returns> ? F : $InferOuterFunctionTypeAsync<Args, Returns>;
  input<const Items extends TupleItems, const Rest extends $ZodFunctionOut = $ZodFunctionOut>(args: Items, rest?: Rest): $ZodFunction<$ZodTuple<Items, Rest>, Returns>;
  input<NewArgs extends $ZodFunctionIn>(args: NewArgs): $ZodFunction<NewArgs, Returns>;
  input(...args: any[]): $ZodFunction<any, Returns>;
  output<NewReturns extends $ZodType>(output: NewReturns): $ZodFunction<Args, NewReturns>;
}
interface $ZodFunctionParams<I extends $ZodFunctionIn, O extends $ZodType> {
  input?: I;
  output?: O;
}
declare const $ZodFunction: $constructor<$ZodFunction>;
interface $ZodPromiseDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "promise";
  innerType: T;
}
interface $ZodPromiseInternals<T extends SomeType = $ZodType> extends $ZodTypeInternals<Promise<output<T>>, MaybeAsync<input<T>>> {
  def: $ZodPromiseDef<T>;
  isst: never;
}
interface $ZodPromise<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodPromiseInternals<T>;
}
declare const $ZodPromise: $constructor<$ZodPromise>;
interface $ZodLazyDef<T extends SomeType = $ZodType> extends $ZodTypeDef {
  type: "lazy";
  getter: () => T;
}
interface $ZodLazyInternals<T extends SomeType = $ZodType> extends $ZodTypeInternals<output<T>, input<T>> {
  def: $ZodLazyDef<T>;
  isst: never;
  /** Auto-cached way to retrieve the inner schema */
  innerType: T;
  pattern: T["_zod"]["pattern"];
  propValues: T["_zod"]["propValues"];
  optin: T["_zod"]["optin"];
  optout: T["_zod"]["optout"];
}
interface $ZodLazy<T extends SomeType = $ZodType> extends $ZodType {
  _zod: $ZodLazyInternals<T>;
}
declare const $ZodLazy: $constructor<$ZodLazy>;
interface $ZodCustomDef<O = unknown> extends $ZodTypeDef, $ZodCheckDef {
  type: "custom";
  check: "custom";
  path?: PropertyKey[] | undefined;
  error?: $ZodErrorMap | undefined;
  params?: Record<string, any> | undefined;
  fn: (arg: O) => unknown;
}
interface $ZodCustomInternals<O = unknown, I = unknown> extends $ZodTypeInternals<O, I>, $ZodCheckInternals<O> {
  def: $ZodCustomDef;
  issc: $ZodIssue;
  isst: never;
  bag: LoosePartial<{
    Class: typeof Class;
  }>;
}
interface $ZodCustom<O = unknown, I = unknown> extends $ZodType {
  _zod: $ZodCustomInternals<O, I>;
}
declare const $ZodCustom: $constructor<$ZodCustom>;
type $ZodTypes = $ZodString | $ZodNumber | $ZodBigInt | $ZodBoolean | $ZodDate | $ZodSymbol | $ZodUndefined | $ZodNullable | $ZodNull | $ZodAny | $ZodUnknown | $ZodNever | $ZodVoid | $ZodArray | $ZodObject | $ZodUnion | $ZodIntersection | $ZodTuple | $ZodRecord | $ZodMap | $ZodSet | $ZodLiteral | $ZodEnum | $ZodFunction | $ZodPromise | $ZodLazy | $ZodOptional | $ZodDefault | $ZodPrefault | $ZodTemplateLiteral | $ZodCustom | $ZodTransform | $ZodNonOptional | $ZodReadonly | $ZodNaN | $ZodPipe | $ZodSuccess | $ZodCatch | $ZodFile;
type $ZodStringFormatTypes = $ZodGUID | $ZodUUID | $ZodEmail | $ZodURL | $ZodEmoji | $ZodNanoID | $ZodCUID | $ZodCUID2 | $ZodULID | $ZodXID | $ZodKSUID | $ZodISODateTime | $ZodISODate | $ZodISOTime | $ZodISODuration | $ZodIPv4 | $ZodIPv6 | $ZodMAC | $ZodCIDRv4 | $ZodCIDRv6 | $ZodBase64 | $ZodBase64URL | $ZodE164 | $ZodJWT | $ZodCustomStringFormat<"hex"> | $ZodCustomStringFormat<HashFormat> | $ZodCustomStringFormat<"hostname">;
//#endregion
//#region node_modules/zod/v4/core/checks.d.cts
interface $ZodCheckDef {
  check: string;
  error?: $ZodErrorMap<never> | undefined;
  /** If true, no later checks will be executed if this check fails. Default `false`. */
  abort?: boolean | undefined;
  /** If provided, the check runs only when this returns `true`. By default, it is skipped if prior parsing produced aborting issues. */
  when?: ((payload: ParsePayload) => boolean) | undefined;
}
interface $ZodCheckInternals<T> {
  def: $ZodCheckDef;
  /** The set of issues this check might throw. */
  issc?: $ZodIssueBase;
  check(payload: ParsePayload<T>): MaybeAsync<void>;
  onattach: ((schema: $ZodType) => void)[];
}
interface $ZodCheck<in T = never> {
  _zod: $ZodCheckInternals<T>;
}
declare const $ZodCheck: $constructor<$ZodCheck<any>>;
interface $ZodCheckLessThanDef extends $ZodCheckDef {
  check: "less_than";
  value: Numeric;
  inclusive: boolean;
}
interface $ZodCheckLessThanInternals<T extends Numeric = Numeric> extends $ZodCheckInternals<T> {
  def: $ZodCheckLessThanDef;
  issc: $ZodIssueTooBig<T>;
}
interface $ZodCheckLessThan<T extends Numeric = Numeric> extends $ZodCheck<T> {
  _zod: $ZodCheckLessThanInternals<T>;
}
declare const $ZodCheckLessThan: $constructor<$ZodCheckLessThan>;
interface $ZodCheckGreaterThanDef extends $ZodCheckDef {
  check: "greater_than";
  value: Numeric;
  inclusive: boolean;
}
interface $ZodCheckGreaterThanInternals<T extends Numeric = Numeric> extends $ZodCheckInternals<T> {
  def: $ZodCheckGreaterThanDef;
  issc: $ZodIssueTooSmall<T>;
}
interface $ZodCheckGreaterThan<T extends Numeric = Numeric> extends $ZodCheck<T> {
  _zod: $ZodCheckGreaterThanInternals<T>;
}
declare const $ZodCheckGreaterThan: $constructor<$ZodCheckGreaterThan>;
interface $ZodCheckMultipleOfDef<T extends number | bigint = number | bigint> extends $ZodCheckDef {
  check: "multiple_of";
  value: T;
}
interface $ZodCheckMultipleOfInternals<T extends number | bigint = number | bigint> extends $ZodCheckInternals<T> {
  def: $ZodCheckMultipleOfDef<T>;
  issc: $ZodIssueNotMultipleOf;
}
interface $ZodCheckMultipleOf<T extends number | bigint = number | bigint> extends $ZodCheck<T> {
  _zod: $ZodCheckMultipleOfInternals<T>;
}
declare const $ZodCheckMultipleOf: $constructor<$ZodCheckMultipleOf<number | bigint>>;
type $ZodNumberFormats = "int32" | "uint32" | "float32" | "float64" | "safeint";
interface $ZodCheckNumberFormatDef extends $ZodCheckDef {
  check: "number_format";
  format: $ZodNumberFormats;
}
interface $ZodCheckNumberFormatInternals extends $ZodCheckInternals<number> {
  def: $ZodCheckNumberFormatDef;
  issc: $ZodIssueInvalidType | $ZodIssueTooBig<"number"> | $ZodIssueTooSmall<"number">;
}
interface $ZodCheckNumberFormat extends $ZodCheck<number> {
  _zod: $ZodCheckNumberFormatInternals;
}
declare const $ZodCheckNumberFormat: $constructor<$ZodCheckNumberFormat>;
type $ZodBigIntFormats = "int64" | "uint64";
interface $ZodCheckBigIntFormatDef extends $ZodCheckDef {
  check: "bigint_format";
  format: $ZodBigIntFormats | undefined;
}
interface $ZodCheckBigIntFormatInternals extends $ZodCheckInternals<bigint> {
  def: $ZodCheckBigIntFormatDef;
  issc: $ZodIssueTooBig<"bigint"> | $ZodIssueTooSmall<"bigint">;
}
interface $ZodCheckBigIntFormat extends $ZodCheck<bigint> {
  _zod: $ZodCheckBigIntFormatInternals;
}
declare const $ZodCheckBigIntFormat: $constructor<$ZodCheckBigIntFormat>;
interface $ZodCheckMaxSizeDef extends $ZodCheckDef {
  check: "max_size";
  maximum: number;
}
interface $ZodCheckMaxSizeInternals<T extends HasSize = HasSize> extends $ZodCheckInternals<T> {
  def: $ZodCheckMaxSizeDef;
  issc: $ZodIssueTooBig<T>;
}
interface $ZodCheckMaxSize<T extends HasSize = HasSize> extends $ZodCheck<T> {
  _zod: $ZodCheckMaxSizeInternals<T>;
}
declare const $ZodCheckMaxSize: $constructor<$ZodCheckMaxSize>;
interface $ZodCheckMinSizeDef extends $ZodCheckDef {
  check: "min_size";
  minimum: number;
}
interface $ZodCheckMinSizeInternals<T extends HasSize = HasSize> extends $ZodCheckInternals<T> {
  def: $ZodCheckMinSizeDef;
  issc: $ZodIssueTooSmall<T>;
}
interface $ZodCheckMinSize<T extends HasSize = HasSize> extends $ZodCheck<T> {
  _zod: $ZodCheckMinSizeInternals<T>;
}
declare const $ZodCheckMinSize: $constructor<$ZodCheckMinSize>;
interface $ZodCheckSizeEqualsDef extends $ZodCheckDef {
  check: "size_equals";
  size: number;
}
interface $ZodCheckSizeEqualsInternals<T extends HasSize = HasSize> extends $ZodCheckInternals<T> {
  def: $ZodCheckSizeEqualsDef;
  issc: $ZodIssueTooBig<T> | $ZodIssueTooSmall<T>;
}
interface $ZodCheckSizeEquals<T extends HasSize = HasSize> extends $ZodCheck<T> {
  _zod: $ZodCheckSizeEqualsInternals<T>;
}
declare const $ZodCheckSizeEquals: $constructor<$ZodCheckSizeEquals>;
interface $ZodCheckMaxLengthDef extends $ZodCheckDef {
  check: "max_length";
  maximum: number;
}
interface $ZodCheckMaxLengthInternals<T extends HasLength = HasLength> extends $ZodCheckInternals<T> {
  def: $ZodCheckMaxLengthDef;
  issc: $ZodIssueTooBig<T>;
}
interface $ZodCheckMaxLength<T extends HasLength = HasLength> extends $ZodCheck<T> {
  _zod: $ZodCheckMaxLengthInternals<T>;
}
declare const $ZodCheckMaxLength: $constructor<$ZodCheckMaxLength>;
interface $ZodCheckMinLengthDef extends $ZodCheckDef {
  check: "min_length";
  minimum: number;
}
interface $ZodCheckMinLengthInternals<T extends HasLength = HasLength> extends $ZodCheckInternals<T> {
  def: $ZodCheckMinLengthDef;
  issc: $ZodIssueTooSmall<T>;
}
interface $ZodCheckMinLength<T extends HasLength = HasLength> extends $ZodCheck<T> {
  _zod: $ZodCheckMinLengthInternals<T>;
}
declare const $ZodCheckMinLength: $constructor<$ZodCheckMinLength>;
interface $ZodCheckLengthEqualsDef extends $ZodCheckDef {
  check: "length_equals";
  length: number;
}
interface $ZodCheckLengthEqualsInternals<T extends HasLength = HasLength> extends $ZodCheckInternals<T> {
  def: $ZodCheckLengthEqualsDef;
  issc: $ZodIssueTooBig<T> | $ZodIssueTooSmall<T>;
}
interface $ZodCheckLengthEquals<T extends HasLength = HasLength> extends $ZodCheck<T> {
  _zod: $ZodCheckLengthEqualsInternals<T>;
}
declare const $ZodCheckLengthEquals: $constructor<$ZodCheckLengthEquals>;
type $ZodStringFormats = "email" | "url" | "emoji" | "uuid" | "guid" | "nanoid" | "cuid" | "cuid2" | "ulid" | "xid" | "ksuid" | "datetime" | "date" | "time" | "duration" | "ipv4" | "ipv6" | "cidrv4" | "cidrv6" | "base64" | "base64url" | "json_string" | "e164" | "lowercase" | "uppercase" | "regex" | "jwt" | "starts_with" | "ends_with" | "includes";
interface $ZodCheckStringFormatDef<Format extends string = string> extends $ZodCheckDef {
  check: "string_format";
  format: Format;
  pattern?: RegExp | undefined;
}
interface $ZodCheckStringFormatInternals extends $ZodCheckInternals<string> {
  def: $ZodCheckStringFormatDef;
  issc: $ZodIssueInvalidStringFormat;
}
interface $ZodCheckStringFormat extends $ZodCheck<string> {
  _zod: $ZodCheckStringFormatInternals;
}
declare const $ZodCheckStringFormat: $constructor<$ZodCheckStringFormat>;
interface $ZodCheckRegexDef extends $ZodCheckStringFormatDef {
  format: "regex";
  pattern: RegExp;
}
interface $ZodCheckRegexInternals extends $ZodCheckInternals<string> {
  def: $ZodCheckRegexDef;
  issc: $ZodIssueInvalidStringFormat;
}
interface $ZodCheckRegex extends $ZodCheck<string> {
  _zod: $ZodCheckRegexInternals;
}
declare const $ZodCheckRegex: $constructor<$ZodCheckRegex>;
interface $ZodCheckLowerCaseDef extends $ZodCheckStringFormatDef<"lowercase"> {}
interface $ZodCheckLowerCaseInternals extends $ZodCheckInternals<string> {
  def: $ZodCheckLowerCaseDef;
  issc: $ZodIssueInvalidStringFormat;
}
interface $ZodCheckLowerCase extends $ZodCheck<string> {
  _zod: $ZodCheckLowerCaseInternals;
}
declare const $ZodCheckLowerCase: $constructor<$ZodCheckLowerCase>;
interface $ZodCheckUpperCaseDef extends $ZodCheckStringFormatDef<"uppercase"> {}
interface $ZodCheckUpperCaseInternals extends $ZodCheckInternals<string> {
  def: $ZodCheckUpperCaseDef;
  issc: $ZodIssueInvalidStringFormat;
}
interface $ZodCheckUpperCase extends $ZodCheck<string> {
  _zod: $ZodCheckUpperCaseInternals;
}
declare const $ZodCheckUpperCase: $constructor<$ZodCheckUpperCase>;
interface $ZodCheckIncludesDef extends $ZodCheckStringFormatDef<"includes"> {
  includes: string;
  position?: number | undefined;
}
interface $ZodCheckIncludesInternals extends $ZodCheckInternals<string> {
  def: $ZodCheckIncludesDef;
  issc: $ZodIssueInvalidStringFormat;
}
interface $ZodCheckIncludes extends $ZodCheck<string> {
  _zod: $ZodCheckIncludesInternals;
}
declare const $ZodCheckIncludes: $constructor<$ZodCheckIncludes>;
interface $ZodCheckStartsWithDef extends $ZodCheckStringFormatDef<"starts_with"> {
  prefix: string;
}
interface $ZodCheckStartsWithInternals extends $ZodCheckInternals<string> {
  def: $ZodCheckStartsWithDef;
  issc: $ZodIssueInvalidStringFormat;
}
interface $ZodCheckStartsWith extends $ZodCheck<string> {
  _zod: $ZodCheckStartsWithInternals;
}
declare const $ZodCheckStartsWith: $constructor<$ZodCheckStartsWith>;
interface $ZodCheckEndsWithDef extends $ZodCheckStringFormatDef<"ends_with"> {
  suffix: string;
}
interface $ZodCheckEndsWithInternals extends $ZodCheckInternals<string> {
  def: $ZodCheckEndsWithDef;
  issc: $ZodIssueInvalidStringFormat;
}
interface $ZodCheckEndsWith extends $ZodCheckInternals<string> {
  _zod: $ZodCheckEndsWithInternals;
}
declare const $ZodCheckEndsWith: $constructor<$ZodCheckEndsWith>;
interface $ZodCheckPropertyDef extends $ZodCheckDef {
  check: "property";
  property: string;
  schema: $ZodType;
}
interface $ZodCheckPropertyInternals<T extends object = object> extends $ZodCheckInternals<T> {
  def: $ZodCheckPropertyDef;
  issc: $ZodIssue;
}
interface $ZodCheckProperty<T extends object = object> extends $ZodCheck<T> {
  _zod: $ZodCheckPropertyInternals<T>;
}
declare const $ZodCheckProperty: $constructor<$ZodCheckProperty>;
interface $ZodCheckMimeTypeDef extends $ZodCheckDef {
  check: "mime_type";
  mime: MimeTypes[];
}
interface $ZodCheckMimeTypeInternals<T extends File = File> extends $ZodCheckInternals<T> {
  def: $ZodCheckMimeTypeDef;
  issc: $ZodIssueInvalidValue;
}
interface $ZodCheckMimeType<T extends File = File> extends $ZodCheck<T> {
  _zod: $ZodCheckMimeTypeInternals<T>;
}
declare const $ZodCheckMimeType: $constructor<$ZodCheckMimeType>;
interface $ZodCheckOverwriteDef<T = unknown> extends $ZodCheckDef {
  check: "overwrite";
  tx(value: T): T;
}
interface $ZodCheckOverwriteInternals<T = unknown> extends $ZodCheckInternals<T> {
  def: $ZodCheckOverwriteDef<T>;
  issc: never;
}
interface $ZodCheckOverwrite<T = unknown> extends $ZodCheck<T> {
  _zod: $ZodCheckOverwriteInternals<T>;
}
declare const $ZodCheckOverwrite: $constructor<$ZodCheckOverwrite>;
type $ZodChecks = $ZodCheckLessThan | $ZodCheckGreaterThan | $ZodCheckMultipleOf | $ZodCheckNumberFormat | $ZodCheckBigIntFormat | $ZodCheckMaxSize | $ZodCheckMinSize | $ZodCheckSizeEquals | $ZodCheckMaxLength | $ZodCheckMinLength | $ZodCheckLengthEquals | $ZodCheckStringFormat | $ZodCheckProperty | $ZodCheckMimeType | $ZodCheckOverwrite;
type $ZodStringFormatChecks = $ZodCheckRegex | $ZodCheckLowerCase | $ZodCheckUpperCase | $ZodCheckIncludes | $ZodCheckStartsWith | $ZodCheckEndsWith | $ZodStringFormatTypes;
//#endregion
//#region node_modules/zod/v4/core/errors.d.cts
interface $ZodIssueBase {
  readonly code?: string;
  readonly input?: unknown;
  readonly path: PropertyKey[];
  readonly message: string;
}
type $ZodInvalidTypeExpected = "string" | "number" | "int" | "boolean" | "bigint" | "symbol" | "undefined" | "null" | "never" | "void" | "date" | "array" | "object" | "tuple" | "record" | "map" | "set" | "file" | "nonoptional" | "nan" | "function" | (string & {});
interface $ZodIssueInvalidType<Input = unknown> extends $ZodIssueBase {
  readonly code: "invalid_type";
  readonly expected: $ZodInvalidTypeExpected;
  readonly input?: Input;
}
interface $ZodIssueTooBig<Input = unknown> extends $ZodIssueBase {
  readonly code: "too_big";
  readonly origin: "number" | "int" | "bigint" | "date" | "string" | "array" | "set" | "file" | (string & {});
  readonly maximum: number | bigint;
  readonly inclusive?: boolean;
  readonly exact?: boolean;
  readonly input?: Input;
}
interface $ZodIssueTooSmall<Input = unknown> extends $ZodIssueBase {
  readonly code: "too_small";
  readonly origin: "number" | "int" | "bigint" | "date" | "string" | "array" | "set" | "file" | (string & {});
  readonly minimum: number | bigint;
  /** True if the allowable range includes the minimum */
  readonly inclusive?: boolean;
  /** True if the allowed value is fixed (e.g.` z.length(5)`), not a range (`z.minLength(5)`) */
  readonly exact?: boolean;
  readonly input?: Input;
}
interface $ZodIssueInvalidStringFormat extends $ZodIssueBase {
  readonly code: "invalid_format";
  readonly format: $ZodStringFormats | (string & {});
  readonly pattern?: string;
  readonly input?: string;
}
interface $ZodIssueNotMultipleOf<Input extends number | bigint = number | bigint> extends $ZodIssueBase {
  readonly code: "not_multiple_of";
  readonly divisor: number;
  readonly input?: Input;
}
interface $ZodIssueUnrecognizedKeys extends $ZodIssueBase {
  readonly code: "unrecognized_keys";
  readonly keys: string[];
  readonly input?: Record<string, unknown>;
}
interface $ZodIssueInvalidUnionNoMatch extends $ZodIssueBase {
  readonly code: "invalid_union";
  readonly errors: $ZodIssue[][];
  readonly input?: unknown;
  readonly discriminator?: string | undefined;
  readonly options?: Primitive[];
  readonly inclusive?: true;
}
interface $ZodIssueInvalidUnionMultipleMatch extends $ZodIssueBase {
  readonly code: "invalid_union";
  readonly errors: [];
  readonly input?: unknown;
  readonly discriminator?: string | undefined;
  readonly inclusive: false;
}
type $ZodIssueInvalidUnion = $ZodIssueInvalidUnionNoMatch | $ZodIssueInvalidUnionMultipleMatch;
interface $ZodIssueInvalidKey<Input = unknown> extends $ZodIssueBase {
  readonly code: "invalid_key";
  readonly origin: "map" | "record";
  readonly issues: $ZodIssue[];
  readonly input?: Input;
}
interface $ZodIssueInvalidElement<Input = unknown> extends $ZodIssueBase {
  readonly code: "invalid_element";
  readonly origin: "map" | "set";
  readonly key: unknown;
  readonly issues: $ZodIssue[];
  readonly input?: Input;
}
interface $ZodIssueInvalidValue<Input = unknown> extends $ZodIssueBase {
  readonly code: "invalid_value";
  readonly values: Primitive[];
  readonly input?: Input;
}
interface $ZodIssueCustom extends $ZodIssueBase {
  readonly code: "custom";
  readonly params?: Record<string, any> | undefined;
  readonly input?: unknown;
}
interface $ZodIssueStringCommonFormats extends $ZodIssueInvalidStringFormat {
  format: Exclude<$ZodStringFormats, "regex" | "jwt" | "starts_with" | "ends_with" | "includes">;
}
interface $ZodIssueStringInvalidRegex extends $ZodIssueInvalidStringFormat {
  format: "regex";
  pattern: string;
}
interface $ZodIssueStringInvalidJWT extends $ZodIssueInvalidStringFormat {
  format: "jwt";
  algorithm?: string;
}
interface $ZodIssueStringStartsWith extends $ZodIssueInvalidStringFormat {
  format: "starts_with";
  prefix: string;
}
interface $ZodIssueStringEndsWith extends $ZodIssueInvalidStringFormat {
  format: "ends_with";
  suffix: string;
}
interface $ZodIssueStringIncludes extends $ZodIssueInvalidStringFormat {
  format: "includes";
  includes: string;
}
type $ZodStringFormatIssues = $ZodIssueStringCommonFormats | $ZodIssueStringInvalidRegex | $ZodIssueStringInvalidJWT | $ZodIssueStringStartsWith | $ZodIssueStringEndsWith | $ZodIssueStringIncludes;
type $ZodIssue = $ZodIssueInvalidType | $ZodIssueTooBig | $ZodIssueTooSmall | $ZodIssueInvalidStringFormat | $ZodIssueNotMultipleOf | $ZodIssueUnrecognizedKeys | $ZodIssueInvalidUnion | $ZodIssueInvalidKey | $ZodIssueInvalidElement | $ZodIssueInvalidValue | $ZodIssueCustom;
type $ZodIssueCode = $ZodIssue["code"];
type $ZodInternalIssue<T extends $ZodIssueBase = $ZodIssue> = T extends any ? RawIssue$1<T> : never;
type RawIssue$1<T extends $ZodIssueBase> = T extends any ? Flatten<MakePartial<T, "message" | "path"> & {
  /** The input data */readonly input: unknown; /** The schema or check that originated this issue. */
  readonly inst?: $ZodType | $ZodCheck; /** If `true`, Zod will continue executing checks/refinements after this issue. */
  readonly continue?: boolean | undefined;
} & Record<string, unknown>> : never;
type $ZodRawIssue<T extends $ZodIssueBase = $ZodIssue> = $ZodInternalIssue<T>;
interface $ZodErrorMap<T extends $ZodIssueBase = $ZodIssue> {
  (issue: $ZodRawIssue<T>): {
    message: string;
  } | string | undefined | null;
}
interface $ZodError<T = unknown> extends Error {
  type: T;
  issues: $ZodIssue[];
  _zod: {
    output: T;
    def: $ZodIssue[];
  };
  stack?: string;
  name: string;
}
declare const $ZodError: $constructor<$ZodError>;
interface $ZodRealError<T = any> extends $ZodError<T> {}
declare const $ZodRealError: $constructor<$ZodRealError>;
type $ZodFlattenedError<T, U = string> = _FlattenedError<T, U>;
type _FlattenedError<T, U = string> = {
  formErrors: U[];
  fieldErrors: { [P in keyof T]?: U[] };
};
declare function flattenError<T>(error: $ZodError<T>): _FlattenedError<T>;
declare function flattenError<T, U>(error: $ZodError<T>, mapper?: (issue: $ZodIssue) => U): _FlattenedError<T, U>;
type _ZodFormattedError<T, U = string> = T extends [any, ...any[]] ? { [K in keyof T]?: $ZodFormattedError<T[K], U> } : T extends any[] ? {
  [k: number]: $ZodFormattedError<T[number], U>;
} : T extends object ? Flatten<{ [K in keyof T]?: $ZodFormattedError<T[K], U> }> : any;
type $ZodFormattedError<T, U = string> = {
  _errors: U[];
} & Flatten<_ZodFormattedError<T, U>>;
declare function formatError<T>(error: $ZodError<T>): $ZodFormattedError<T>;
declare function formatError<T, U>(error: $ZodError<T>, mapper?: (issue: $ZodIssue) => U): $ZodFormattedError<T, U>;
type $ZodErrorTree<T, U = string> = T extends Primitive ? {
  errors: U[];
} : T extends [any, ...any[]] ? {
  errors: U[];
  items?: { [K in keyof T]?: $ZodErrorTree<T[K], U> };
} : T extends any[] ? {
  errors: U[];
  items?: Array<$ZodErrorTree<T[number], U>>;
} : T extends object ? {
  errors: U[];
  properties?: { [K in keyof T]?: $ZodErrorTree<T[K], U> };
} : {
  errors: U[];
};
declare function treeifyError<T>(error: $ZodError<T>): $ZodErrorTree<T>;
declare function treeifyError<T, U>(error: $ZodError<T>, mapper?: (issue: $ZodIssue) => U): $ZodErrorTree<T, U>;
/** Format a ZodError as a human-readable string in the following form.
 *
 * From
 *
 * ```ts
 * ZodError {
 *   issues: [
 *     {
 *       expected: 'string',
 *       code: 'invalid_type',
 *       path: [ 'username' ],
 *       message: 'Invalid input: expected string'
 *     },
 *     {
 *       expected: 'number',
 *       code: 'invalid_type',
 *       path: [ 'favoriteNumbers', 1 ],
 *       message: 'Invalid input: expected number'
 *     }
 *   ];
 * }
 * ```
 *
 * to
 *
 * ```
 * username
 *   ✖ Expected number, received string at "username
 * favoriteNumbers[0]
 *   ✖ Invalid input: expected number
 * ```
 */
declare function toDotPath(_path: readonly (string | number | symbol | StandardSchemaV1.PathSegment)[]): string;
declare function prettifyError(error: StandardSchemaV1.FailureResult): string;
//#endregion
//#region node_modules/zod/v4/core/core.d.cts
type ZodTrait = {
  _zod: {
    def: any;
    [k: string]: any;
  };
};
interface $constructor<T extends ZodTrait, D = T["_zod"]["def"]> {
  new (def: D): T;
  init(inst: T, def: D): asserts inst is T;
}
/** A special constant with type `never` */
declare const NEVER: never;
declare function $constructor<T extends ZodTrait, D = T["_zod"]["def"]>(name: string, initializer: (inst: T, def: D) => void, params?: {
  Parent?: typeof Class;
}): $constructor<T, D>;
declare const $brand: unique symbol;
type $brand<T extends string | number | symbol = string | number | symbol> = {
  [$brand]: { [k in T]: true };
};
type $ZodBranded<T extends SomeType, Brand extends string | number | symbol, Dir extends "in" | "out" | "inout" = "out"> = T & (Dir extends "inout" ? {
  _zod: {
    input: input<T> & $brand<Brand>;
    output: output<T> & $brand<Brand>;
  };
} : Dir extends "in" ? {
  _zod: {
    input: input<T> & $brand<Brand>;
  };
} : {
  _zod: {
    output: output<T> & $brand<Brand>;
  };
});
type $ZodNarrow<T extends SomeType, Out> = T & {
  _zod: {
    output: Out;
  };
};
declare class $ZodAsyncError extends Error {
  constructor();
}
declare class $ZodEncodeError extends Error {
  constructor(name: string);
}
type input<T> = T extends {
  _zod: {
    input: any;
  };
} ? T["_zod"]["input"] : unknown;
type output<T> = T extends {
  _zod: {
    output: any;
  };
} ? T["_zod"]["output"] : unknown;
interface $ZodConfig {
  /** Custom error map. Overrides `config().localeError`. */
  customError?: $ZodErrorMap | undefined;
  /** Localized error map. Lowest priority. */
  localeError?: $ZodErrorMap | undefined;
  /** Disable JIT schema compilation. Useful in environments that disallow `eval`. */
  jitless?: boolean | undefined;
}
declare const globalConfig: $ZodConfig;
declare function config(newConfig?: Partial<$ZodConfig>): $ZodConfig;
//#endregion
//#region node_modules/zod/v4/core/parse.d.cts
type $ZodErrorClass = {
  new (issues: $ZodIssue[]): $ZodError;
};
type $Parse = <T extends $ZodType>(schema: T, value: unknown, _ctx?: ParseContext<$ZodIssue>, _params?: {
  callee?: AnyFunc;
  Err?: $ZodErrorClass;
}) => output<T>;
declare const _parse: (_Err: $ZodErrorClass) => $Parse;
declare const parse$1: $Parse;
type $ParseAsync = <T extends $ZodType>(schema: T, value: unknown, _ctx?: ParseContext<$ZodIssue>, _params?: {
  callee?: AnyFunc;
  Err?: $ZodErrorClass;
}) => Promise<output<T>>;
declare const _parseAsync: (_Err: $ZodErrorClass) => $ParseAsync;
declare const parseAsync$1: $ParseAsync;
type $SafeParse = <T extends $ZodType>(schema: T, value: unknown, _ctx?: ParseContext<$ZodIssue>) => SafeParseResult<output<T>>;
declare const _safeParse: (_Err: $ZodErrorClass) => $SafeParse;
declare const safeParse$1: $SafeParse;
type $SafeParseAsync = <T extends $ZodType>(schema: T, value: unknown, _ctx?: ParseContext<$ZodIssue>) => Promise<SafeParseResult<output<T>>>;
declare const _safeParseAsync: (_Err: $ZodErrorClass) => $SafeParseAsync;
declare const safeParseAsync$1: $SafeParseAsync;
type $Encode = <T extends $ZodType>(schema: T, value: output<T>, _ctx?: ParseContext<$ZodIssue>) => input<T>;
declare const _encode: (_Err: $ZodErrorClass) => $Encode;
declare const encode$1: $Encode;
type $Decode = <T extends $ZodType>(schema: T, value: input<T>, _ctx?: ParseContext<$ZodIssue>) => output<T>;
declare const _decode: (_Err: $ZodErrorClass) => $Decode;
declare const decode$1: $Decode;
type $EncodeAsync = <T extends $ZodType>(schema: T, value: output<T>, _ctx?: ParseContext<$ZodIssue>) => Promise<input<T>>;
declare const _encodeAsync: (_Err: $ZodErrorClass) => $EncodeAsync;
declare const encodeAsync$1: $EncodeAsync;
type $DecodeAsync = <T extends $ZodType>(schema: T, value: input<T>, _ctx?: ParseContext<$ZodIssue>) => Promise<output<T>>;
declare const _decodeAsync: (_Err: $ZodErrorClass) => $DecodeAsync;
declare const decodeAsync$1: $DecodeAsync;
type $SafeEncode = <T extends $ZodType>(schema: T, value: output<T>, _ctx?: ParseContext<$ZodIssue>) => SafeParseResult<input<T>>;
declare const _safeEncode: (_Err: $ZodErrorClass) => $SafeEncode;
declare const safeEncode$1: $SafeEncode;
type $SafeDecode = <T extends $ZodType>(schema: T, value: input<T>, _ctx?: ParseContext<$ZodIssue>) => SafeParseResult<output<T>>;
declare const _safeDecode: (_Err: $ZodErrorClass) => $SafeDecode;
declare const safeDecode$1: $SafeDecode;
type $SafeEncodeAsync = <T extends $ZodType>(schema: T, value: output<T>, _ctx?: ParseContext<$ZodIssue>) => Promise<SafeParseResult<input<T>>>;
declare const _safeEncodeAsync: (_Err: $ZodErrorClass) => $SafeEncodeAsync;
declare const safeEncodeAsync$1: $SafeEncodeAsync;
type $SafeDecodeAsync = <T extends $ZodType>(schema: T, value: input<T>, _ctx?: ParseContext<$ZodIssue>) => Promise<SafeParseResult<output<T>>>;
declare const _safeDecodeAsync: (_Err: $ZodErrorClass) => $SafeDecodeAsync;
declare const safeDecodeAsync$1: $SafeDecodeAsync;
declare namespace regexes_d_exports {
  export { base64$1 as base64, base64url$1 as base64url, bigint$1 as bigint, boolean$1 as boolean, browserEmail, cidrv4$1 as cidrv4, cidrv6$1 as cidrv6, cuid$1 as cuid, cuid2$1 as cuid2, date$1 as date, datetime, domain, duration, e164$1 as e164, email$1 as email, emoji$1 as emoji, extendedDuration, guid$1 as guid, hex$1 as hex, hostname$1 as hostname, html5Email, httpProtocol, idnEmail, integer, ipv4$1 as ipv4, ipv6$1 as ipv6, ksuid$1 as ksuid, lowercase, mac$1 as mac, md5_base64, md5_base64url, md5_hex, nanoid$1 as nanoid, _null$2 as null, number$1 as number, rfc5322Email, sha1_base64, sha1_base64url, sha1_hex, sha256_base64, sha256_base64url, sha256_hex, sha384_base64, sha384_base64url, sha384_hex, sha512_base64, sha512_base64url, sha512_hex, string$1 as string, time, ulid$1 as ulid, _undefined$2 as undefined, unicodeEmail, uppercase, uuid$1 as uuid, uuid4, uuid6, uuid7, xid$1 as xid };
}
/**
 * @deprecated CUID v1 is deprecated by its authors due to information leakage
 * (timestamps embedded in the id). Use {@link cuid2} instead.
 * See https://github.com/paralleldrive/cuid.
 */
declare const cuid$1: RegExp;
declare const cuid2$1: RegExp;
declare const ulid$1: RegExp;
declare const xid$1: RegExp;
declare const ksuid$1: RegExp;
declare const nanoid$1: RegExp;
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
declare const duration: RegExp;
/** Implements ISO 8601-2 extensions like explicit +- prefixes, mixing weeks with other units, and fractional/negative components. */
declare const extendedDuration: RegExp;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
declare const guid$1: RegExp;
/** Returns a regex for validating an RFC 9562/4122 UUID.
 *
 * @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
declare const uuid$1: (version?: number | undefined) => RegExp;
declare const uuid4: RegExp;
declare const uuid6: RegExp;
declare const uuid7: RegExp;
/** Practical email validation */
declare const email$1: RegExp;
/** Equivalent to the HTML5 input[type=email] validation implemented by browsers. Source: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input/email */
declare const html5Email: RegExp;
/** The classic emailregex.com regex for RFC 5322-compliant emails */
declare const rfc5322Email: RegExp;
/** A loose regex that allows Unicode characters, enforces length limits, and that's about it. */
declare const unicodeEmail: RegExp;
declare const idnEmail: RegExp;
declare const browserEmail: RegExp;
declare function emoji$1(): RegExp;
declare const ipv4$1: RegExp;
declare const ipv6$1: RegExp;
declare const mac$1: (delimiter?: string) => RegExp;
declare const cidrv4$1: RegExp;
declare const cidrv6$1: RegExp;
declare const base64$1: RegExp;
declare const base64url$1: RegExp;
declare const hostname$1: RegExp;
declare const domain: RegExp;
declare const httpProtocol: RegExp;
declare const e164$1: RegExp;
declare const date$1: RegExp;
declare function time(args: {
  precision?: number | null;
}): RegExp;
declare function datetime(args: {
  precision?: number | null;
  offset?: boolean;
  local?: boolean;
}): RegExp;
declare const string$1: (params?: {
  minimum?: number | undefined;
  maximum?: number | undefined;
}) => RegExp;
declare const bigint$1: RegExp;
declare const integer: RegExp;
declare const number$1: RegExp;
declare const boolean$1: RegExp;
declare const _null$2: RegExp;
declare const _undefined$2: RegExp;
declare const lowercase: RegExp;
declare const uppercase: RegExp;
declare const hex$1: RegExp;
declare const md5_hex: RegExp;
declare const md5_base64: RegExp;
declare const md5_base64url: RegExp;
declare const sha1_hex: RegExp;
declare const sha1_base64: RegExp;
declare const sha1_base64url: RegExp;
declare const sha256_hex: RegExp;
declare const sha256_base64: RegExp;
declare const sha256_base64url: RegExp;
declare const sha384_hex: RegExp;
declare const sha384_base64: RegExp;
declare const sha384_base64url: RegExp;
declare const sha512_hex: RegExp;
declare const sha512_base64: RegExp;
declare const sha512_base64url: RegExp;
//#endregion
//#region node_modules/zod/v4/locales/ar.d.cts
declare function _default$53(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/az.d.cts
declare function _default$52(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/be.d.cts
declare function _default$51(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/bg.d.cts
declare function _default$50(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ca.d.cts
declare function _default$49(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/cs.d.cts
declare function _default$48(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/da.d.cts
declare function _default$47(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/de.d.cts
declare function _default$46(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/el.d.cts
declare function _default$45(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/en.d.cts
declare function _default$44(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/eo.d.cts
declare function _default$43(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/es.d.cts
declare function _default$42(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/fa.d.cts
declare function _default$41(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/fi.d.cts
declare function _default$40(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/fr.d.cts
declare function _default$39(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/fr-CA.d.cts
declare function _default$38(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/he.d.cts
declare function _default$37(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/hr.d.cts
declare function _default$36(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/hu.d.cts
declare function _default$35(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/hy.d.cts
declare function _default$34(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/id.d.cts
declare function _default$33(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/is.d.cts
declare function _default$32(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/it.d.cts
declare function _default$31(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ja.d.cts
declare function _default$30(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ka.d.cts
declare function _default$29(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/kh.d.cts
declare function _default$28(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/km.d.cts
declare function _default$27(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ko.d.cts
declare function _default$26(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/lt.d.cts
declare function _default$25(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/mk.d.cts
declare function _default$24(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ms.d.cts
declare function _default$23(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/nl.d.cts
declare function _default$22(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/no.d.cts
declare function _default$21(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ota.d.cts
declare function _default$20(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ps.d.cts
declare function _default$19(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/pl.d.cts
declare function _default$18(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/pt.d.cts
declare function _default$17(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ro.d.cts
declare function _default$16(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ru.d.cts
declare function _default$15(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/sl.d.cts
declare function _default$14(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/sv.d.cts
declare function _default$13(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ta.d.cts
declare function _default$12(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/th.d.cts
declare function _default$11(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/tr.d.cts
declare function _default$10(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ua.d.cts
declare function _default$9(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/uk.d.cts
declare function _default$8(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/ur.d.cts
declare function _default$7(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/uz.d.cts
declare function _default$6(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/vi.d.cts
declare function _default$5(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/zh-CN.d.cts
declare function _default$4(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/zh-TW.d.cts
declare function _default$3(): {
  localeError: $ZodErrorMap;
};
//#endregion
//#region node_modules/zod/v4/locales/yo.d.cts
declare function _default$2(): {
  localeError: $ZodErrorMap;
};
declare namespace index_d_exports$1 {
  export { _default$53 as ar, _default$52 as az, _default$51 as be, _default$50 as bg, _default$49 as ca, _default$48 as cs, _default$47 as da, _default$46 as de, _default$45 as el, _default$44 as en, _default$43 as eo, _default$42 as es, _default$41 as fa, _default$40 as fi, _default$39 as fr, _default$38 as frCA, _default$37 as he, _default$36 as hr, _default$35 as hu, _default$34 as hy, _default$33 as id, _default$32 as is, _default$31 as it, _default$30 as ja, _default$29 as ka, _default$28 as kh, _default$27 as km, _default$26 as ko, _default$25 as lt, _default$24 as mk, _default$23 as ms, _default$22 as nl, _default$21 as no, _default$20 as ota, _default$18 as pl, _default$19 as ps, _default$17 as pt, _default$16 as ro, _default$15 as ru, _default$14 as sl, _default$13 as sv, _default$12 as ta, _default$11 as th, _default$10 as tr, _default$9 as ua, _default$8 as uk, _default$7 as ur, _default$6 as uz, _default$5 as vi, _default$2 as yo, _default$4 as zhCN, _default$3 as zhTW };
}
//#endregion
//#region node_modules/zod/v4/core/doc.d.cts
type ModeWriter = (doc: Doc, modes: {
  execution: "sync" | "async";
}) => void;
declare class Doc {
  args: string[];
  content: string[];
  indent: number;
  constructor(args?: string[]);
  indented(fn: (doc: Doc) => void): void;
  write(fn: ModeWriter): void;
  write(line: string): void;
  compile(): any;
}
//#endregion
//#region node_modules/zod/v4/core/api.d.cts
type Params<T extends $ZodType | $ZodCheck, IssueTypes extends $ZodIssueBase, OmitKeys extends keyof T["_zod"]["def"] = never> = Flatten<Partial<EmptyToNever<Omit<T["_zod"]["def"], OmitKeys> & ([IssueTypes] extends [never] ? {} : {
  error?: string | $ZodErrorMap<IssueTypes> | undefined; /** @deprecated This parameter is deprecated. Use `error` instead. */
  message?: string | undefined;
})>>>;
type TypeParams<T extends $ZodType = $ZodType & {
  _isst: never;
}, AlsoOmit extends Exclude<keyof T["_zod"]["def"], "type" | "checks" | "error"> = never> = Params<T, NonNullable<T["_zod"]["isst"]>, "type" | "checks" | "error" | AlsoOmit>;
type CheckParams<T extends $ZodCheck = $ZodCheck, // & { _issc: never },
AlsoOmit extends Exclude<keyof T["_zod"]["def"], "check" | "error"> = never> = Params<T, NonNullable<T["_zod"]["issc"]>, "check" | "error" | AlsoOmit>;
type StringFormatParams<T extends $ZodStringFormat = $ZodStringFormat, AlsoOmit extends Exclude<keyof T["_zod"]["def"], "type" | "coerce" | "checks" | "error" | "check" | "format"> = never> = Params<T, NonNullable<T["_zod"]["isst"] | T["_zod"]["issc"]>, "type" | "coerce" | "checks" | "error" | "check" | "format" | AlsoOmit>;
type CheckStringFormatParams<T extends $ZodStringFormat = $ZodStringFormat, AlsoOmit extends Exclude<keyof T["_zod"]["def"], "type" | "coerce" | "checks" | "error" | "check" | "format"> = never> = Params<T, NonNullable<T["_zod"]["issc"]>, "type" | "coerce" | "checks" | "error" | "check" | "format" | AlsoOmit>;
type CheckTypeParams<T extends $ZodType & $ZodCheck = $ZodType & $ZodCheck, AlsoOmit extends Exclude<keyof T["_zod"]["def"], "type" | "checks" | "error" | "check"> = never> = Params<T, NonNullable<T["_zod"]["isst"] | T["_zod"]["issc"]>, "type" | "checks" | "error" | "check" | AlsoOmit>;
type $ZodStringParams = TypeParams<$ZodString<string>, "coerce">;
declare function _string<T extends $ZodString>(Class: SchemaClass<T>, params?: string | $ZodStringParams): T;
declare function _coercedString<T extends $ZodString>(Class: SchemaClass<T>, params?: string | $ZodStringParams): T;
type $ZodStringFormatParams = CheckTypeParams<$ZodStringFormat, "format" | "coerce" | "when" | "pattern">;
type $ZodCheckStringFormatParams = CheckParams<$ZodCheckStringFormat, "format">;
type $ZodEmailParams = StringFormatParams<$ZodEmail, "when">;
type $ZodCheckEmailParams = CheckStringFormatParams<$ZodEmail, "when">;
declare function _email<T extends $ZodEmail>(Class: SchemaClass<T>, params?: string | $ZodEmailParams | $ZodCheckEmailParams): T;
type $ZodGUIDParams = StringFormatParams<$ZodGUID, "pattern" | "when">;
type $ZodCheckGUIDParams = CheckStringFormatParams<$ZodGUID, "pattern" | "when">;
declare function _guid<T extends $ZodGUID>(Class: SchemaClass<T>, params?: string | $ZodGUIDParams | $ZodCheckGUIDParams): T;
type $ZodUUIDParams = StringFormatParams<$ZodUUID, "pattern" | "when">;
type $ZodCheckUUIDParams = CheckStringFormatParams<$ZodUUID, "pattern" | "when">;
declare function _uuid<T extends $ZodUUID>(Class: SchemaClass<T>, params?: string | $ZodUUIDParams | $ZodCheckUUIDParams): T;
type $ZodUUIDv4Params = StringFormatParams<$ZodUUID, "pattern" | "when">;
type $ZodCheckUUIDv4Params = CheckStringFormatParams<$ZodUUID, "pattern" | "when">;
declare function _uuidv4<T extends $ZodUUID>(Class: SchemaClass<T>, params?: string | $ZodUUIDv4Params | $ZodCheckUUIDv4Params): T;
type $ZodUUIDv6Params = StringFormatParams<$ZodUUID, "pattern" | "when">;
type $ZodCheckUUIDv6Params = CheckStringFormatParams<$ZodUUID, "pattern" | "when">;
declare function _uuidv6<T extends $ZodUUID>(Class: SchemaClass<T>, params?: string | $ZodUUIDv6Params | $ZodCheckUUIDv6Params): T;
type $ZodUUIDv7Params = StringFormatParams<$ZodUUID, "pattern" | "when">;
type $ZodCheckUUIDv7Params = CheckStringFormatParams<$ZodUUID, "pattern" | "when">;
declare function _uuidv7<T extends $ZodUUID>(Class: SchemaClass<T>, params?: string | $ZodUUIDv7Params | $ZodCheckUUIDv7Params): T;
type $ZodURLParams = StringFormatParams<$ZodURL, "when">;
type $ZodCheckURLParams = CheckStringFormatParams<$ZodURL, "when">;
declare function _url<T extends $ZodURL>(Class: SchemaClass<T>, params?: string | $ZodURLParams | $ZodCheckURLParams): T;
type $ZodEmojiParams = StringFormatParams<$ZodEmoji, "when">;
type $ZodCheckEmojiParams = CheckStringFormatParams<$ZodEmoji, "when">;
declare function _emoji<T extends $ZodEmoji>(Class: SchemaClass<T>, params?: string | $ZodEmojiParams | $ZodCheckEmojiParams): T;
type $ZodNanoIDParams = StringFormatParams<$ZodNanoID, "when">;
type $ZodCheckNanoIDParams = CheckStringFormatParams<$ZodNanoID, "when">;
declare function _nanoid<T extends $ZodNanoID>(Class: SchemaClass<T>, params?: string | $ZodNanoIDParams | $ZodCheckNanoIDParams): T;
/**
 * @deprecated CUID v1 is deprecated by its authors due to information leakage
 * (timestamps embedded in the id). Use {@link _cuid2} instead.
 * See https://github.com/paralleldrive/cuid.
 */
type $ZodCUIDParams = StringFormatParams<$ZodCUID, "when">;
/**
 * @deprecated CUID v1 is deprecated by its authors due to information leakage
 * (timestamps embedded in the id). Use {@link _cuid2} instead.
 * See https://github.com/paralleldrive/cuid.
 */
type $ZodCheckCUIDParams = CheckStringFormatParams<$ZodCUID, "when">;
/**
 * @deprecated CUID v1 is deprecated by its authors due to information leakage
 * (timestamps embedded in the id). Use {@link _cuid2} instead.
 * See https://github.com/paralleldrive/cuid.
 */
declare function _cuid<T extends $ZodCUID>(Class: SchemaClass<T>, params?: string | $ZodCUIDParams | $ZodCheckCUIDParams): T;
type $ZodCUID2Params = StringFormatParams<$ZodCUID2, "when">;
type $ZodCheckCUID2Params = CheckStringFormatParams<$ZodCUID2, "when">;
declare function _cuid2<T extends $ZodCUID2>(Class: SchemaClass<T>, params?: string | $ZodCUID2Params | $ZodCheckCUID2Params): T;
type $ZodULIDParams = StringFormatParams<$ZodULID, "when">;
type $ZodCheckULIDParams = CheckStringFormatParams<$ZodULID, "when">;
declare function _ulid<T extends $ZodULID>(Class: SchemaClass<T>, params?: string | $ZodULIDParams | $ZodCheckULIDParams): T;
type $ZodXIDParams = StringFormatParams<$ZodXID, "when">;
type $ZodCheckXIDParams = CheckStringFormatParams<$ZodXID, "when">;
declare function _xid<T extends $ZodXID>(Class: SchemaClass<T>, params?: string | $ZodXIDParams | $ZodCheckXIDParams): T;
type $ZodKSUIDParams = StringFormatParams<$ZodKSUID, "when">;
type $ZodCheckKSUIDParams = CheckStringFormatParams<$ZodKSUID, "when">;
declare function _ksuid<T extends $ZodKSUID>(Class: SchemaClass<T>, params?: string | $ZodKSUIDParams | $ZodCheckKSUIDParams): T;
type $ZodIPv4Params = StringFormatParams<$ZodIPv4, "pattern" | "when" | "version">;
type $ZodCheckIPv4Params = CheckStringFormatParams<$ZodIPv4, "pattern" | "when" | "version">;
declare function _ipv4<T extends $ZodIPv4>(Class: SchemaClass<T>, params?: string | $ZodIPv4Params | $ZodCheckIPv4Params): T;
type $ZodIPv6Params = StringFormatParams<$ZodIPv6, "pattern" | "when" | "version">;
type $ZodCheckIPv6Params = CheckStringFormatParams<$ZodIPv6, "pattern" | "when" | "version">;
declare function _ipv6<T extends $ZodIPv6>(Class: SchemaClass<T>, params?: string | $ZodIPv6Params | $ZodCheckIPv6Params): T;
type $ZodMACParams = StringFormatParams<$ZodMAC, "pattern" | "when">;
type $ZodCheckMACParams = CheckStringFormatParams<$ZodMAC, "pattern" | "when">;
declare function _mac<T extends $ZodMAC>(Class: SchemaClass<T>, params?: string | $ZodMACParams | $ZodCheckMACParams): T;
type $ZodCIDRv4Params = StringFormatParams<$ZodCIDRv4, "pattern" | "when">;
type $ZodCheckCIDRv4Params = CheckStringFormatParams<$ZodCIDRv4, "pattern" | "when">;
declare function _cidrv4<T extends $ZodCIDRv4>(Class: SchemaClass<T>, params?: string | $ZodCIDRv4Params | $ZodCheckCIDRv4Params): T;
type $ZodCIDRv6Params = StringFormatParams<$ZodCIDRv6, "pattern" | "when">;
type $ZodCheckCIDRv6Params = CheckStringFormatParams<$ZodCIDRv6, "pattern" | "when">;
declare function _cidrv6<T extends $ZodCIDRv6>(Class: SchemaClass<T>, params?: string | $ZodCIDRv6Params | $ZodCheckCIDRv6Params): T;
type $ZodBase64Params = StringFormatParams<$ZodBase64, "pattern" | "when">;
type $ZodCheckBase64Params = CheckStringFormatParams<$ZodBase64, "pattern" | "when">;
declare function _base64<T extends $ZodBase64>(Class: SchemaClass<T>, params?: string | $ZodBase64Params | $ZodCheckBase64Params): T;
type $ZodBase64URLParams = StringFormatParams<$ZodBase64URL, "pattern" | "when">;
type $ZodCheckBase64URLParams = CheckStringFormatParams<$ZodBase64URL, "pattern" | "when">;
declare function _base64url<T extends $ZodBase64URL>(Class: SchemaClass<T>, params?: string | $ZodBase64URLParams | $ZodCheckBase64URLParams): T;
type $ZodE164Params = StringFormatParams<$ZodE164, "when">;
type $ZodCheckE164Params = CheckStringFormatParams<$ZodE164, "when">;
declare function _e164<T extends $ZodE164>(Class: SchemaClass<T>, params?: string | $ZodE164Params | $ZodCheckE164Params): T;
type $ZodJWTParams = StringFormatParams<$ZodJWT, "pattern" | "when">;
type $ZodCheckJWTParams = CheckStringFormatParams<$ZodJWT, "pattern" | "when">;
declare function _jwt<T extends $ZodJWT>(Class: SchemaClass<T>, params?: string | $ZodJWTParams | $ZodCheckJWTParams): T;
declare const TimePrecision: {
  readonly Any: null;
  readonly Minute: -1;
  readonly Second: 0;
  readonly Millisecond: 3;
  readonly Microsecond: 6;
};
type $ZodISODateTimeParams = StringFormatParams<$ZodISODateTime, "pattern" | "when">;
type $ZodCheckISODateTimeParams = CheckStringFormatParams<$ZodISODateTime, "pattern" | "when">;
declare function _isoDateTime<T extends $ZodISODateTime>(Class: SchemaClass<T>, params?: string | $ZodISODateTimeParams | $ZodCheckISODateTimeParams): T;
type $ZodISODateParams = StringFormatParams<$ZodISODate, "pattern" | "when">;
type $ZodCheckISODateParams = CheckStringFormatParams<$ZodISODate, "pattern" | "when">;
declare function _isoDate<T extends $ZodISODate>(Class: SchemaClass<T>, params?: string | $ZodISODateParams | $ZodCheckISODateParams): T;
type $ZodISOTimeParams = StringFormatParams<$ZodISOTime, "pattern" | "when">;
type $ZodCheckISOTimeParams = CheckStringFormatParams<$ZodISOTime, "pattern" | "when">;
declare function _isoTime<T extends $ZodISOTime>(Class: SchemaClass<T>, params?: string | $ZodISOTimeParams | $ZodCheckISOTimeParams): T;
type $ZodISODurationParams = StringFormatParams<$ZodISODuration, "when">;
type $ZodCheckISODurationParams = CheckStringFormatParams<$ZodISODuration, "when">;
declare function _isoDuration<T extends $ZodISODuration>(Class: SchemaClass<T>, params?: string | $ZodISODurationParams | $ZodCheckISODurationParams): T;
type $ZodNumberParams = TypeParams<$ZodNumber<number>, "coerce">;
type $ZodNumberFormatParams = CheckTypeParams<$ZodNumberFormat, "format" | "coerce">;
type $ZodCheckNumberFormatParams = CheckParams<$ZodCheckNumberFormat, "format" | "when">;
declare function _number<T extends $ZodNumber>(Class: SchemaClass<T>, params?: string | $ZodNumberParams): T;
declare function _coercedNumber<T extends $ZodNumber>(Class: SchemaClass<T>, params?: string | $ZodNumberParams): T;
declare function _int<T extends $ZodNumberFormat>(Class: SchemaClass<T>, params?: string | $ZodCheckNumberFormatParams): T;
declare function _float32<T extends $ZodNumberFormat>(Class: SchemaClass<T>, params?: string | $ZodCheckNumberFormatParams): T;
declare function _float64<T extends $ZodNumberFormat>(Class: SchemaClass<T>, params?: string | $ZodCheckNumberFormatParams): T;
declare function _int32<T extends $ZodNumberFormat>(Class: SchemaClass<T>, params?: string | $ZodCheckNumberFormatParams): T;
declare function _uint32<T extends $ZodNumberFormat>(Class: SchemaClass<T>, params?: string | $ZodCheckNumberFormatParams): T;
type $ZodBooleanParams = TypeParams<$ZodBoolean<boolean>, "coerce">;
declare function _boolean<T extends $ZodBoolean>(Class: SchemaClass<T>, params?: string | $ZodBooleanParams): T;
declare function _coercedBoolean<T extends $ZodBoolean>(Class: SchemaClass<T>, params?: string | $ZodBooleanParams): T;
type $ZodBigIntParams = TypeParams<$ZodBigInt<bigint>>;
type $ZodBigIntFormatParams = CheckTypeParams<$ZodBigIntFormat, "format" | "coerce">;
type $ZodCheckBigIntFormatParams = CheckParams<$ZodCheckBigIntFormat, "format" | "when">;
declare function _bigint<T extends $ZodBigInt>(Class: SchemaClass<T>, params?: string | $ZodBigIntParams): T;
declare function _coercedBigint<T extends $ZodBigInt>(Class: SchemaClass<T>, params?: string | $ZodBigIntParams): T;
declare function _int64<T extends $ZodBigIntFormat>(Class: SchemaClass<T>, params?: string | $ZodBigIntFormatParams): T;
declare function _uint64<T extends $ZodBigIntFormat>(Class: SchemaClass<T>, params?: string | $ZodBigIntFormatParams): T;
type $ZodSymbolParams = TypeParams<$ZodSymbol>;
declare function _symbol<T extends $ZodSymbol>(Class: SchemaClass<T>, params?: string | $ZodSymbolParams): T;
type $ZodUndefinedParams = TypeParams<$ZodUndefined>;
declare function _undefined$1<T extends $ZodUndefined>(Class: SchemaClass<T>, params?: string | $ZodUndefinedParams): T;
type $ZodNullParams = TypeParams<$ZodNull>;
declare function _null$1<T extends $ZodNull>(Class: SchemaClass<T>, params?: string | $ZodNullParams): T;
type $ZodAnyParams = TypeParams<$ZodAny>;
declare function _any<T extends $ZodAny>(Class: SchemaClass<T>): T;
type $ZodUnknownParams = TypeParams<$ZodUnknown>;
declare function _unknown<T extends $ZodUnknown>(Class: SchemaClass<T>): T;
type $ZodNeverParams = TypeParams<$ZodNever>;
declare function _never<T extends $ZodNever>(Class: SchemaClass<T>, params?: string | $ZodNeverParams): T;
type $ZodVoidParams = TypeParams<$ZodVoid>;
declare function _void$1<T extends $ZodVoid>(Class: SchemaClass<T>, params?: string | $ZodVoidParams): T;
type $ZodDateParams = TypeParams<$ZodDate, "coerce">;
declare function _date<T extends $ZodDate>(Class: SchemaClass<T>, params?: string | $ZodDateParams): T;
declare function _coercedDate<T extends $ZodDate>(Class: SchemaClass<T>, params?: string | $ZodDateParams): T;
type $ZodNaNParams = TypeParams<$ZodNaN>;
declare function _nan<T extends $ZodNaN>(Class: SchemaClass<T>, params?: string | $ZodNaNParams): T;
type $ZodCheckLessThanParams = CheckParams<$ZodCheckLessThan, "inclusive" | "value" | "when">;
declare function _lt(value: Numeric, params?: string | $ZodCheckLessThanParams): $ZodCheckLessThan<Numeric>;
declare function _lte(value: Numeric, params?: string | $ZodCheckLessThanParams): $ZodCheckLessThan<Numeric>;
type $ZodCheckGreaterThanParams = CheckParams<$ZodCheckGreaterThan, "inclusive" | "value" | "when">;
declare function _gt(value: Numeric, params?: string | $ZodCheckGreaterThanParams): $ZodCheckGreaterThan;
declare function _gte(value: Numeric, params?: string | $ZodCheckGreaterThanParams): $ZodCheckGreaterThan;
declare function _positive(params?: string | $ZodCheckGreaterThanParams): $ZodCheckGreaterThan;
declare function _negative(params?: string | $ZodCheckLessThanParams): $ZodCheckLessThan;
declare function _nonpositive(params?: string | $ZodCheckLessThanParams): $ZodCheckLessThan;
declare function _nonnegative(params?: string | $ZodCheckGreaterThanParams): $ZodCheckGreaterThan;
type $ZodCheckMultipleOfParams = CheckParams<$ZodCheckMultipleOf, "value" | "when">;
declare function _multipleOf(value: number | bigint, params?: string | $ZodCheckMultipleOfParams): $ZodCheckMultipleOf;
type $ZodCheckMaxSizeParams = CheckParams<$ZodCheckMaxSize, "maximum" | "when">;
declare function _maxSize(maximum: number, params?: string | $ZodCheckMaxSizeParams): $ZodCheckMaxSize<HasSize>;
type $ZodCheckMinSizeParams = CheckParams<$ZodCheckMinSize, "minimum" | "when">;
declare function _minSize(minimum: number, params?: string | $ZodCheckMinSizeParams): $ZodCheckMinSize<HasSize>;
type $ZodCheckSizeEqualsParams = CheckParams<$ZodCheckSizeEquals, "size" | "when">;
declare function _size(size: number, params?: string | $ZodCheckSizeEqualsParams): $ZodCheckSizeEquals<HasSize>;
type $ZodCheckMaxLengthParams = CheckParams<$ZodCheckMaxLength, "maximum" | "when">;
declare function _maxLength(maximum: number, params?: string | $ZodCheckMaxLengthParams): $ZodCheckMaxLength<HasLength>;
type $ZodCheckMinLengthParams = CheckParams<$ZodCheckMinLength, "minimum" | "when">;
declare function _minLength(minimum: number, params?: string | $ZodCheckMinLengthParams): $ZodCheckMinLength<HasLength>;
type $ZodCheckLengthEqualsParams = CheckParams<$ZodCheckLengthEquals, "length" | "when">;
declare function _length(length: number, params?: string | $ZodCheckLengthEqualsParams): $ZodCheckLengthEquals<HasLength>;
type $ZodCheckRegexParams = CheckParams<$ZodCheckRegex, "format" | "pattern" | "when">;
declare function _regex(pattern: RegExp, params?: string | $ZodCheckRegexParams): $ZodCheckRegex;
type $ZodCheckLowerCaseParams = CheckParams<$ZodCheckLowerCase, "format" | "when">;
declare function _lowercase(params?: string | $ZodCheckLowerCaseParams): $ZodCheckLowerCase;
type $ZodCheckUpperCaseParams = CheckParams<$ZodCheckUpperCase, "format" | "when">;
declare function _uppercase(params?: string | $ZodCheckUpperCaseParams): $ZodCheckUpperCase;
type $ZodCheckIncludesParams = CheckParams<$ZodCheckIncludes, "includes" | "format" | "when" | "pattern">;
declare function _includes(includes: string, params?: string | $ZodCheckIncludesParams): $ZodCheckIncludes;
type $ZodCheckStartsWithParams = CheckParams<$ZodCheckStartsWith, "prefix" | "format" | "when" | "pattern">;
declare function _startsWith(prefix: string, params?: string | $ZodCheckStartsWithParams): $ZodCheckStartsWith;
type $ZodCheckEndsWithParams = CheckParams<$ZodCheckEndsWith, "suffix" | "format" | "pattern" | "when">;
declare function _endsWith(suffix: string, params?: string | $ZodCheckEndsWithParams): $ZodCheckEndsWith;
type $ZodCheckPropertyParams = CheckParams<$ZodCheckProperty, "property" | "schema" | "when">;
declare function _property<K extends string, T extends $ZodType>(property: K, schema: T, params?: string | $ZodCheckPropertyParams): $ZodCheckProperty<{ [k in K]: output<T> }>;
type $ZodCheckMimeTypeParams = CheckParams<$ZodCheckMimeType, "mime" | "when">;
declare function _mime(types: MimeTypes[], params?: string | $ZodCheckMimeTypeParams): $ZodCheckMimeType;
declare function _overwrite<T>(tx: (input: T) => T): $ZodCheckOverwrite<T>;
declare function _normalize(form?: "NFC" | "NFD" | "NFKC" | "NFKD" | (string & {})): $ZodCheckOverwrite<string>;
declare function _trim(): $ZodCheckOverwrite<string>;
declare function _toLowerCase(): $ZodCheckOverwrite<string>;
declare function _toUpperCase(): $ZodCheckOverwrite<string>;
declare function _slugify(): $ZodCheckOverwrite<string>;
type $ZodArrayParams = TypeParams<$ZodArray, "element">;
declare function _array<T extends $ZodType>(Class: SchemaClass<$ZodArray>, element: T, params?: string | $ZodArrayParams): $ZodArray<T>;
type $ZodObjectParams = TypeParams<$ZodObject, "shape" | "catchall">;
type $ZodUnionParams = TypeParams<$ZodUnion, "options">;
declare function _union<const T extends readonly $ZodObject[]>(Class: SchemaClass<$ZodUnion>, options: T, params?: string | $ZodUnionParams): $ZodUnion<T>;
type $ZodXorParams = TypeParams<$ZodXor, "options">;
declare function _xor<const T extends readonly $ZodObject[]>(Class: SchemaClass<$ZodXor>, options: T, params?: string | $ZodXorParams): $ZodXor<T>;
interface $ZodTypeDiscriminableInternals<Disc extends string = string> extends $ZodTypeInternals<unknown, { [K in Disc]?: unknown }> {
  propValues: PropValues;
}
interface $ZodTypeDiscriminable<Disc extends string = string> extends $ZodType {
  _zod: $ZodTypeDiscriminableInternals<Disc>;
}
type $ZodDiscriminatedUnionParams = TypeParams<$ZodDiscriminatedUnion, "options" | "discriminator">;
declare function _discriminatedUnion<Types extends [$ZodTypeDiscriminable<Disc>, ...$ZodTypeDiscriminable<Disc>[]], Disc extends string>(Class: SchemaClass<$ZodDiscriminatedUnion>, discriminator: Disc, options: Types, params?: string | $ZodDiscriminatedUnionParams): $ZodDiscriminatedUnion<Types, Disc>;
type $ZodIntersectionParams = TypeParams<$ZodIntersection, "left" | "right">;
declare function _intersection<T extends $ZodObject, U extends $ZodObject>(Class: SchemaClass<$ZodIntersection>, left: T, right: U): $ZodIntersection<T, U>;
type $ZodTupleParams = TypeParams<$ZodTuple, "items" | "rest">;
declare function _tuple<T extends readonly [$ZodType, ...$ZodType[]]>(Class: SchemaClass<$ZodTuple>, items: T, params?: string | $ZodTupleParams): $ZodTuple<T, null>;
declare function _tuple<T extends readonly [$ZodType, ...$ZodType[]], Rest extends $ZodType>(Class: SchemaClass<$ZodTuple>, items: T, rest: Rest, params?: string | $ZodTupleParams): $ZodTuple<T, Rest>;
type $ZodRecordParams = TypeParams<$ZodRecord, "keyType" | "valueType">;
declare function _record<Key extends $ZodRecordKey, Value extends $ZodObject>(Class: SchemaClass<$ZodRecord>, keyType: Key, valueType: Value, params?: string | $ZodRecordParams): $ZodRecord<Key, Value>;
type $ZodMapParams = TypeParams<$ZodMap, "keyType" | "valueType">;
declare function _map<Key extends $ZodObject, Value extends $ZodObject>(Class: SchemaClass<$ZodMap>, keyType: Key, valueType: Value, params?: string | $ZodMapParams): $ZodMap<Key, Value>;
type $ZodSetParams = TypeParams<$ZodSet, "valueType">;
declare function _set<Value extends $ZodObject>(Class: SchemaClass<$ZodSet>, valueType: Value, params?: string | $ZodSetParams): $ZodSet<Value>;
type $ZodEnumParams = TypeParams<$ZodEnum, "entries">;
declare function _enum$1<const T extends string[]>(Class: SchemaClass<$ZodEnum>, values: T, params?: string | $ZodEnumParams): $ZodEnum<ToEnum<T[number]>>;
declare function _enum$1<T extends EnumLike>(Class: SchemaClass<$ZodEnum>, entries: T, params?: string | $ZodEnumParams): $ZodEnum<T>;
/** @deprecated This API has been merged into `z.enum()`. Use `z.enum()` instead.
 *
 * ```ts
 * enum Colors { red, green, blue }
 * z.enum(Colors);
 * ```
 */
declare function _nativeEnum<T extends EnumLike>(Class: SchemaClass<$ZodEnum>, entries: T, params?: string | $ZodEnumParams): $ZodEnum<T>;
type $ZodLiteralParams = TypeParams<$ZodLiteral, "values">;
declare function _literal<const T extends Array<Literal>>(Class: SchemaClass<$ZodLiteral>, value: T, params?: string | $ZodLiteralParams): $ZodLiteral<T[number]>;
declare function _literal<const T extends Literal>(Class: SchemaClass<$ZodLiteral>, value: T, params?: string | $ZodLiteralParams): $ZodLiteral<T>;
type $ZodFileParams = TypeParams<$ZodFile>;
declare function _file(Class: SchemaClass<$ZodFile>, params?: string | $ZodFileParams): $ZodFile;
type $ZodTransformParams = TypeParams<$ZodTransform, "transform">;
declare function _transform<I = unknown, O = I>(Class: SchemaClass<$ZodTransform>, fn: (input: I, ctx?: ParsePayload) => O): $ZodTransform<Awaited<O>, I>;
type $ZodOptionalParams = TypeParams<$ZodOptional, "innerType">;
declare function _optional<T extends $ZodObject>(Class: SchemaClass<$ZodOptional>, innerType: T): $ZodOptional<T>;
type $ZodNullableParams = TypeParams<$ZodNullable, "innerType">;
declare function _nullable<T extends $ZodObject>(Class: SchemaClass<$ZodNullable>, innerType: T): $ZodNullable<T>;
type $ZodDefaultParams = TypeParams<$ZodDefault, "innerType" | "defaultValue">;
declare function _default$1<T extends $ZodObject>(Class: SchemaClass<$ZodDefault>, innerType: T, defaultValue: NoUndefined<output<T>> | (() => NoUndefined<output<T>>)): $ZodDefault<T>;
type $ZodNonOptionalParams = TypeParams<$ZodNonOptional, "innerType">;
declare function _nonoptional<T extends $ZodObject>(Class: SchemaClass<$ZodNonOptional>, innerType: T, params?: string | $ZodNonOptionalParams): $ZodNonOptional<T>;
type $ZodSuccessParams = TypeParams<$ZodSuccess, "innerType">;
declare function _success<T extends $ZodObject>(Class: SchemaClass<$ZodSuccess>, innerType: T): $ZodSuccess<T>;
type $ZodCatchParams = TypeParams<$ZodCatch, "innerType" | "catchValue">;
declare function _catch$1<T extends $ZodObject>(Class: SchemaClass<$ZodCatch>, innerType: T, catchValue: output<T> | ((ctx: $ZodCatchCtx) => output<T>)): $ZodCatch<T>;
type $ZodPipeParams = TypeParams<$ZodPipe, "in" | "out">;
declare function _pipe<const A extends $ZodType, B extends $ZodType<unknown, output<A>> = $ZodType<unknown, output<A>>>(Class: SchemaClass<$ZodPipe>, in_: A, out: B | $ZodType<unknown, output<A>>): $ZodPipe<A, B>;
type $ZodReadonlyParams = TypeParams<$ZodReadonly, "innerType">;
declare function _readonly<T extends $ZodObject>(Class: SchemaClass<$ZodReadonly>, innerType: T): $ZodReadonly<T>;
type $ZodTemplateLiteralParams = TypeParams<$ZodTemplateLiteral, "parts">;
declare function _templateLiteral<const Parts extends $ZodTemplateLiteralPart[]>(Class: SchemaClass<$ZodTemplateLiteral>, parts: Parts, params?: string | $ZodTemplateLiteralParams): $ZodTemplateLiteral<$PartsToTemplateLiteral<Parts>>;
type $ZodLazyParams = TypeParams<$ZodLazy, "getter">;
declare function _lazy<T extends $ZodType>(Class: SchemaClass<$ZodLazy>, getter: () => T): $ZodLazy<T>;
type $ZodPromiseParams = TypeParams<$ZodPromise, "innerType">;
declare function _promise<T extends $ZodObject>(Class: SchemaClass<$ZodPromise>, innerType: T): $ZodPromise<T>;
type $ZodCustomParams = CheckTypeParams<$ZodCustom, "fn">;
declare function _custom<O = unknown, I = O>(Class: SchemaClass<$ZodCustom>, fn: (data: O) => unknown, _params: string | $ZodCustomParams | undefined): $ZodCustom<O, I>;
declare function _refine<O = unknown, I = O>(Class: SchemaClass<$ZodCustom>, fn: (data: O) => unknown, _params: string | $ZodCustomParams | undefined): $ZodCustom<O, I>;
type $ZodSuperRefineIssue<T extends $ZodIssueBase = $ZodIssue> = T extends any ? RawIssue<T> : never;
type RawIssue<T extends $ZodIssueBase> = T extends any ? Flatten<MakePartial<T, "message" | "path"> & {
  /** The schema or check that originated this issue. */readonly inst?: $ZodType | $ZodCheck; /** If `true`, Zod will execute subsequent checks/refinements instead of immediately aborting */
  readonly continue?: boolean | undefined;
} & Record<string, unknown>> : never;
interface $RefinementCtx<T = unknown> extends ParsePayload<T> {
  addIssue(arg: string | $ZodSuperRefineIssue): void;
}
interface $ZodSuperRefineParams {
  /** If provided, the refinement runs only when this returns `true`. By default, it is skipped if prior parsing produced aborting issues. */
  when?: ((payload: ParsePayload) => boolean) | undefined;
}
declare function _superRefine<T>(fn: (arg: T, payload: $RefinementCtx<T>) => void | Promise<void>, params?: $ZodSuperRefineParams): $ZodCheck<T>;
declare function _check<O = unknown>(fn: CheckFn<O>, params?: string | $ZodCustomParams): $ZodCheck<O>;
declare function describe$1<T>(description: string): $ZodCheck<T>;
declare function meta$1<T>(metadata: GlobalMeta): $ZodCheck<T>;
interface $ZodStringBoolParams extends TypeParams {
  truthy?: string[];
  falsy?: string[];
  /**
   * Options: `"sensitive"`, `"insensitive"`
   *
   * @default `"insensitive"`
   */
  case?: "sensitive" | "insensitive" | undefined;
}
declare function _stringbool(Classes: {
  Codec?: typeof $ZodCodec;
  Boolean?: typeof $ZodBoolean;
  String?: typeof $ZodString;
}, _params?: string | $ZodStringBoolParams): $ZodCodec<$ZodString, $ZodBoolean>;
declare function _stringFormat<Format extends string>(Class: typeof $ZodCustomStringFormat, format: Format, fnOrRegex: ((arg: string) => MaybeAsync<unknown>) | RegExp, _params?: string | $ZodStringFormatParams): $ZodCustomStringFormat<Format>;
//#endregion
//#region node_modules/zod/v4/core/json-schema-processors.d.cts
declare function toJSONSchema<T extends $ZodType>(schema: T, params?: ToJSONSchemaParams): ZodStandardJSONSchemaPayload<T>;
declare function toJSONSchema(registry: $ZodRegistry<{
  id?: string | undefined;
}>, params?: RegistryToJSONSchemaParams): {
  schemas: Record<string, ZodStandardJSONSchemaPayload<$ZodType>>;
};
//#endregion
//#region node_modules/zod/v4/core/json-schema-generator.d.cts
/**
 * Parameters for the emit method of JSONSchemaGenerator.
 * @deprecated Use toJSONSchema function instead
 */
type EmitParams = Pick<JSONSchemaGeneratorParams, "cycles" | "reused" | "external">;
/**
 * Parameters for JSONSchemaGenerator constructor.
 * @deprecated Use toJSONSchema function instead
 */
type JSONSchemaGeneratorConstructorParams = Pick<JSONSchemaGeneratorParams, "metadata" | "target" | "unrepresentable" | "override" | "io">;
/**
 * Legacy class-based interface for JSON Schema generation.
 * This class wraps the new functional implementation to provide backward compatibility.
 *
 * @deprecated Use the `toJSONSchema` function instead for new code.
 *
 * @example
 * ```typescript
 * // Legacy usage (still supported)
 * const gen = new JSONSchemaGenerator({ target: "draft-07" });
 * gen.process(schema);
 * const result = gen.emit(schema);
 *
 * // Preferred modern usage
 * const result = toJSONSchema(schema, { target: "draft-07" });
 * ```
 */
declare class JSONSchemaGenerator {
  private ctx;
  /** @deprecated Access via ctx instead */
  get metadataRegistry(): $ZodRegistry<Record<string, any>>;
  /** @deprecated Access via ctx instead */
  get target(): ({} & string) | "draft-2020-12" | "draft-07" | "openapi-3.0" | "draft-04";
  /** @deprecated Access via ctx instead */
  get unrepresentable(): "any" | "throw";
  /** @deprecated Access via ctx instead */
  get override(): (ctx: {
    zodSchema: $ZodType;
    jsonSchema: BaseSchema;
    path: (string | number)[];
  }) => void;
  /** @deprecated Access via ctx instead */
  get io(): "input" | "output";
  /** @deprecated Access via ctx instead */
  get counter(): number;
  set counter(value: number);
  /** @deprecated Access via ctx instead */
  get seen(): Map<$ZodType, Seen>;
  constructor(params?: JSONSchemaGeneratorConstructorParams);
  /**
   * Process a schema to prepare it for JSON Schema generation.
   * This must be called before emit().
   */
  process(schema: $ZodType, _params?: ProcessParams): BaseSchema;
  /**
   * Emit the final JSON Schema after processing.
   * Must call process() first.
   */
  emit(schema: $ZodType, _params?: EmitParams): BaseSchema;
}
declare namespace index_d_exports {
  export { $Decode, $DecodeAsync, $Encode, $EncodeAsync, $InferEnumInput, $InferEnumOutput, $InferInnerFunctionType, $InferInnerFunctionTypeAsync, $InferObjectInput, $InferObjectOutput, $InferOuterFunctionType, $InferOuterFunctionTypeAsync, $InferTupleInputType, $InferTupleOutputType, $InferUnionInput, $InferUnionOutput, $InferZodRecordInput, $InferZodRecordOutput, $Parse, $ParseAsync, $PartsToTemplateLiteral, $RefinementCtx, $SafeDecode, $SafeDecodeAsync, $SafeEncode, $SafeEncodeAsync, $SafeParse, $SafeParseAsync, $ZodAny, $ZodAnyDef, $ZodAnyInternals, $ZodAnyParams, $ZodArray, $ZodArrayDef, $ZodArrayInternals, $ZodArrayParams, $ZodAsyncError, $ZodBase64, $ZodBase64Def, $ZodBase64Internals, $ZodBase64Params, $ZodBase64URL, $ZodBase64URLDef, $ZodBase64URLInternals, $ZodBase64URLParams, $ZodBigInt, $ZodBigIntDef, $ZodBigIntFormat, $ZodBigIntFormatDef, $ZodBigIntFormatInternals, $ZodBigIntFormatParams, $ZodBigIntFormats, $ZodBigIntInternals, $ZodBigIntParams, $ZodBoolean, $ZodBooleanDef, $ZodBooleanInternals, $ZodBooleanParams, $ZodBranded, $ZodCIDRv4, $ZodCIDRv4Def, $ZodCIDRv4Internals, $ZodCIDRv4Params, $ZodCIDRv6, $ZodCIDRv6Def, $ZodCIDRv6Internals, $ZodCIDRv6Params, $ZodCUID, $ZodCUID2, $ZodCUID2Def, $ZodCUID2Internals, $ZodCUID2Params, $ZodCUIDDef, $ZodCUIDInternals, $ZodCUIDParams, $ZodCatch, $ZodCatchCtx, $ZodCatchDef, $ZodCatchInternals, $ZodCatchParams, $ZodCheck, $ZodCheckBase64Params, $ZodCheckBase64URLParams, $ZodCheckBigIntFormat, $ZodCheckBigIntFormatDef, $ZodCheckBigIntFormatInternals, $ZodCheckBigIntFormatParams, $ZodCheckCIDRv4Params, $ZodCheckCIDRv6Params, $ZodCheckCUID2Params, $ZodCheckCUIDParams, $ZodCheckDef, $ZodCheckE164Params, $ZodCheckEmailParams, $ZodCheckEmojiParams, $ZodCheckEndsWith, $ZodCheckEndsWithDef, $ZodCheckEndsWithInternals, $ZodCheckEndsWithParams, $ZodCheckGUIDParams, $ZodCheckGreaterThan, $ZodCheckGreaterThanDef, $ZodCheckGreaterThanInternals, $ZodCheckGreaterThanParams, $ZodCheckIPv4Params, $ZodCheckIPv6Params, $ZodCheckISODateParams, $ZodCheckISODateTimeParams, $ZodCheckISODurationParams, $ZodCheckISOTimeParams, $ZodCheckIncludes, $ZodCheckIncludesDef, $ZodCheckIncludesInternals, $ZodCheckIncludesParams, $ZodCheckInternals, $ZodCheckJWTParams, $ZodCheckKSUIDParams, $ZodCheckLengthEquals, $ZodCheckLengthEqualsDef, $ZodCheckLengthEqualsInternals, $ZodCheckLengthEqualsParams, $ZodCheckLessThan, $ZodCheckLessThanDef, $ZodCheckLessThanInternals, $ZodCheckLessThanParams, $ZodCheckLowerCase, $ZodCheckLowerCaseDef, $ZodCheckLowerCaseInternals, $ZodCheckLowerCaseParams, $ZodCheckMACParams, $ZodCheckMaxLength, $ZodCheckMaxLengthDef, $ZodCheckMaxLengthInternals, $ZodCheckMaxLengthParams, $ZodCheckMaxSize, $ZodCheckMaxSizeDef, $ZodCheckMaxSizeInternals, $ZodCheckMaxSizeParams, $ZodCheckMimeType, $ZodCheckMimeTypeDef, $ZodCheckMimeTypeInternals, $ZodCheckMimeTypeParams, $ZodCheckMinLength, $ZodCheckMinLengthDef, $ZodCheckMinLengthInternals, $ZodCheckMinLengthParams, $ZodCheckMinSize, $ZodCheckMinSizeDef, $ZodCheckMinSizeInternals, $ZodCheckMinSizeParams, $ZodCheckMultipleOf, $ZodCheckMultipleOfDef, $ZodCheckMultipleOfInternals, $ZodCheckMultipleOfParams, $ZodCheckNanoIDParams, $ZodCheckNumberFormat, $ZodCheckNumberFormatDef, $ZodCheckNumberFormatInternals, $ZodCheckNumberFormatParams, $ZodCheckOverwrite, $ZodCheckOverwriteDef, $ZodCheckOverwriteInternals, $ZodCheckProperty, $ZodCheckPropertyDef, $ZodCheckPropertyInternals, $ZodCheckPropertyParams, $ZodCheckRegex, $ZodCheckRegexDef, $ZodCheckRegexInternals, $ZodCheckRegexParams, $ZodCheckSizeEquals, $ZodCheckSizeEqualsDef, $ZodCheckSizeEqualsInternals, $ZodCheckSizeEqualsParams, $ZodCheckStartsWith, $ZodCheckStartsWithDef, $ZodCheckStartsWithInternals, $ZodCheckStartsWithParams, $ZodCheckStringFormat, $ZodCheckStringFormatDef, $ZodCheckStringFormatInternals, $ZodCheckStringFormatParams, $ZodCheckULIDParams, $ZodCheckURLParams, $ZodCheckUUIDParams, $ZodCheckUUIDv4Params, $ZodCheckUUIDv6Params, $ZodCheckUUIDv7Params, $ZodCheckUpperCase, $ZodCheckUpperCaseDef, $ZodCheckUpperCaseInternals, $ZodCheckUpperCaseParams, $ZodCheckXIDParams, $ZodChecks, $ZodCodec, $ZodCodecDef, $ZodCodecInternals, $ZodConfig, $ZodCustom, $ZodCustomDef, $ZodCustomInternals, $ZodCustomParams, $ZodCustomStringFormat, $ZodCustomStringFormatDef, $ZodCustomStringFormatInternals, $ZodDate, $ZodDateDef, $ZodDateInternals, $ZodDateParams, $ZodDefault, $ZodDefaultDef, $ZodDefaultInternals, $ZodDefaultParams, $ZodDiscriminatedUnion, $ZodDiscriminatedUnionDef, $ZodDiscriminatedUnionInternals, $ZodDiscriminatedUnionParams, $ZodE164, $ZodE164Def, $ZodE164Internals, $ZodE164Params, $ZodEmail, $ZodEmailDef, $ZodEmailInternals, $ZodEmailParams, $ZodEmoji, $ZodEmojiDef, $ZodEmojiInternals, $ZodEmojiParams, $ZodEncodeError, $ZodEnum, $ZodEnumDef, $ZodEnumInternals, $ZodEnumParams, $ZodError, $ZodErrorClass, $ZodErrorMap, $ZodErrorTree, $ZodExactOptional, $ZodExactOptionalDef, $ZodExactOptionalInternals, $ZodFile, $ZodFileDef, $ZodFileInternals, $ZodFileParams, $ZodFlattenedError, $ZodFormattedError, $ZodFunction, $ZodFunctionArgs, $ZodFunctionDef, $ZodFunctionIn, $ZodFunctionInternals, $ZodFunctionOut, $ZodFunctionParams, $ZodGUID, $ZodGUIDDef, $ZodGUIDInternals, $ZodGUIDParams, $ZodIPv4, $ZodIPv4Def, $ZodIPv4Internals, $ZodIPv4Params, $ZodIPv6, $ZodIPv6Def, $ZodIPv6Internals, $ZodIPv6Params, $ZodISODate, $ZodISODateDef, $ZodISODateInternals, $ZodISODateParams, $ZodISODateTime, $ZodISODateTimeDef, $ZodISODateTimeInternals, $ZodISODateTimeParams, $ZodISODuration, $ZodISODurationDef, $ZodISODurationInternals, $ZodISODurationParams, $ZodISOTime, $ZodISOTimeDef, $ZodISOTimeInternals, $ZodISOTimeParams, $ZodInternalIssue, $ZodIntersection, $ZodIntersectionDef, $ZodIntersectionInternals, $ZodIntersectionParams, $ZodInvalidTypeExpected, $ZodIssue, $ZodIssueBase, $ZodIssueCode, $ZodIssueCustom, $ZodIssueInvalidElement, $ZodIssueInvalidKey, $ZodIssueInvalidStringFormat, $ZodIssueInvalidType, $ZodIssueInvalidUnion, $ZodIssueInvalidValue, $ZodIssueNotMultipleOf, $ZodIssueStringCommonFormats, $ZodIssueStringEndsWith, $ZodIssueStringIncludes, $ZodIssueStringInvalidJWT, $ZodIssueStringInvalidRegex, $ZodIssueStringStartsWith, $ZodIssueTooBig, $ZodIssueTooSmall, $ZodIssueUnrecognizedKeys, $ZodJWT, $ZodJWTDef, $ZodJWTInternals, $ZodJWTParams, $ZodKSUID, $ZodKSUIDDef, $ZodKSUIDInternals, $ZodKSUIDParams, $ZodLazy, $ZodLazyDef, $ZodLazyInternals, $ZodLazyParams, $ZodLiteral, $ZodLiteralDef, $ZodLiteralInternals, $ZodLiteralParams, $ZodLooseShape, $ZodMAC, $ZodMACDef, $ZodMACInternals, $ZodMACParams, $ZodMap, $ZodMapDef, $ZodMapInternals, $ZodMapParams, $ZodNaN, $ZodNaNDef, $ZodNaNInternals, $ZodNaNParams, $ZodNanoID, $ZodNanoIDDef, $ZodNanoIDInternals, $ZodNanoIDParams, $ZodNarrow, $ZodNever, $ZodNeverDef, $ZodNeverInternals, $ZodNeverParams, $ZodNonOptional, $ZodNonOptionalDef, $ZodNonOptionalInternals, $ZodNonOptionalParams, $ZodNull, $ZodNullDef, $ZodNullInternals, $ZodNullParams, $ZodNullable, $ZodNullableDef, $ZodNullableInternals, $ZodNullableParams, $ZodNumber, $ZodNumberDef, $ZodNumberFormat, $ZodNumberFormatDef, $ZodNumberFormatInternals, $ZodNumberFormatParams, $ZodNumberFormats, $ZodNumberInternals, $ZodNumberParams, $ZodObject, $ZodObjectConfig, $ZodObjectDef, $ZodObjectInternals, $ZodObjectJIT, $ZodObjectParams, $ZodOptional, $ZodOptionalDef, $ZodOptionalInternals, $ZodOptionalParams, $ZodPipe, $ZodPipeDef, $ZodPipeInternals, $ZodPipeParams, $ZodPrefault, $ZodPrefaultDef, $ZodPrefaultInternals, $ZodPreprocess, $ZodPreprocessDef, $ZodPreprocessInternals, $ZodPromise, $ZodPromiseDef, $ZodPromiseInternals, $ZodPromiseParams, $ZodRawIssue, $ZodReadonly, $ZodReadonlyDef, $ZodReadonlyInternals, $ZodReadonlyParams, $ZodRealError, $ZodRecord, $ZodRecordDef, $ZodRecordInternals, $ZodRecordKey, $ZodRecordParams, $ZodRegistry, $ZodSet, $ZodSetDef, $ZodSetInternals, $ZodSetParams, $ZodShape, $ZodStandardSchema, $ZodString, $ZodStringBoolParams, $ZodStringDef, $ZodStringFormat, $ZodStringFormatChecks, $ZodStringFormatDef, $ZodStringFormatInternals, $ZodStringFormatIssues, $ZodStringFormatParams, $ZodStringFormatTypes, $ZodStringFormats, $ZodStringInternals, $ZodStringParams, $ZodSuccess, $ZodSuccessDef, $ZodSuccessInternals, $ZodSuccessParams, $ZodSuperRefineIssue, $ZodSuperRefineParams, $ZodSymbol, $ZodSymbolDef, $ZodSymbolInternals, $ZodSymbolParams, $ZodTemplateLiteral, $ZodTemplateLiteralDef, $ZodTemplateLiteralInternals, $ZodTemplateLiteralParams, $ZodTemplateLiteralPart, $ZodTransform, $ZodTransformDef, $ZodTransformInternals, $ZodTransformParams, $ZodTuple, $ZodTupleDef, $ZodTupleInternals, $ZodTupleParams, $ZodType, $ZodTypeDef, $ZodTypeDiscriminable, $ZodTypeDiscriminableInternals, $ZodTypeInternals, $ZodTypes, $ZodULID, $ZodULIDDef, $ZodULIDInternals, $ZodULIDParams, $ZodURL, $ZodURLDef, $ZodURLInternals, $ZodURLParams, $ZodUUID, $ZodUUIDDef, $ZodUUIDInternals, $ZodUUIDParams, $ZodUUIDv4Params, $ZodUUIDv6Params, $ZodUUIDv7Params, $ZodUndefined, $ZodUndefinedDef, $ZodUndefinedInternals, $ZodUndefinedParams, $ZodUnion, $ZodUnionDef, $ZodUnionInternals, $ZodUnionParams, $ZodUnknown, $ZodUnknownDef, $ZodUnknownInternals, $ZodUnknownParams, $ZodVoid, $ZodVoidDef, $ZodVoidInternals, $ZodVoidParams, $ZodXID, $ZodXIDDef, $ZodXIDInternals, $ZodXIDParams, $ZodXor, $ZodXorInternals, $ZodXorParams, $brand, $catchall, $constructor, $input, $loose, $output, $partial, $replace, $strict, $strip, CheckFn, CheckParams, CheckStringFormatParams, CheckTypeParams, ConcatenateTupleOfStrings, ConvertPartsToStringTuple, Doc, File, GlobalMeta, json_schema_d_exports as JSONSchema, JSONSchemaGenerator, JSONSchemaGeneratorParams, JSONSchemaMeta, NEVER, Params, ParseContext, ParseContextInternal, ParsePayload, ProcessParams, Processor, RegistryToJSONSchemaParams, Seen, SomeType, StringFormatParams, TimePrecision, ToJSONSchemaContext, ToJSONSchemaParams, ToTemplateLiteral, TypeParams, ZodStandardJSONSchemaPayload, ZodStandardSchemaWithJSON$1 as ZodStandardSchemaWithJSON, _$ZodType, _$ZodTypeInternals, _any, _array, _base64, _base64url, _bigint, _boolean, _catch$1 as _catch, _check, _cidrv4, _cidrv6, _coercedBigint, _coercedBoolean, _coercedDate, _coercedNumber, _coercedString, _cuid, _cuid2, _custom, _date, _decode, _decodeAsync, _default$1 as _default, _discriminatedUnion, _e164, _email, _emoji, _encode, _encodeAsync, _endsWith, _enum$1 as _enum, _file, _float32, _float64, _gt, _gte, _guid, _includes, _int, _int32, _int64, _intersection, _ipv4, _ipv6, _isoDate, _isoDateTime, _isoDuration, _isoTime, _jwt, _ksuid, _lazy, _length, _literal, _lowercase, _lt, _lte, _mac, _map, _lte as _max, _maxLength, _maxSize, _mime, _gte as _min, _minLength, _minSize, _multipleOf, _nan, _nanoid, _nativeEnum, _negative, _never, _nonnegative, _nonoptional, _nonpositive, _normalize, _null$1 as _null, _nullable, _number, _optional, _overwrite, _parse, _parseAsync, _pipe, _positive, _promise, _property, _readonly, _record, _refine, _regex, _safeDecode, _safeDecodeAsync, _safeEncode, _safeEncodeAsync, _safeParse, _safeParseAsync, _set, _size, _slugify, _startsWith, _string, _stringFormat, _stringbool, _success, _superRefine, _symbol, _templateLiteral, _toLowerCase, _toUpperCase, _transform, _trim, _tuple, _uint32, _uint64, _ulid, _undefined$1 as _undefined, _union, _unknown, _uppercase, _url, _uuid, _uuidv4, _uuidv6, _uuidv7, _void$1 as _void, _xid, _xor, clone, config, createStandardJSONSchemaMethod, createToJSONSchemaMethod, decode$1 as decode, decodeAsync$1 as decodeAsync, describe$1 as describe, encode$1 as encode, encodeAsync$1 as encodeAsync, extractDefs, finalize, flattenError, formatError, globalConfig, globalRegistry, output as infer, initializeContext, input, isValidBase64, isValidBase64URL, isValidJWT, index_d_exports$1 as locales, meta$1 as meta, output, parse$1 as parse, parseAsync$1 as parseAsync, prettifyError, process, regexes_d_exports as regexes, registry, safeDecode$1 as safeDecode, safeDecodeAsync$1 as safeDecodeAsync, safeEncode$1 as safeEncode, safeEncodeAsync$1 as safeEncodeAsync, safeParse$1 as safeParse, safeParseAsync$1 as safeParseAsync, toDotPath, toJSONSchema, treeifyError, util_d_exports as util, version };
}
//#endregion
//#region node_modules/zod/v4/classic/errors.d.cts
/** @deprecated Use `z.core.$ZodIssue` from `@zod/core` instead, especially if you are building a library on top of Zod. */
type ZodIssue = $ZodIssue;
/** An Error-like class used to store Zod validation issues.  */
interface ZodError<T = unknown> extends $ZodError<T> {
  /** @deprecated Use the `z.treeifyError(err)` function instead. */
  format(): $ZodFormattedError<T>;
  format<U>(mapper: (issue: $ZodIssue) => U): $ZodFormattedError<T, U>;
  /** @deprecated Use the `z.treeifyError(err)` function instead. */
  flatten(): $ZodFlattenedError<T>;
  flatten<U>(mapper: (issue: $ZodIssue) => U): $ZodFlattenedError<T, U>;
  /** @deprecated Push directly to `.issues` instead. */
  addIssue(issue: $ZodIssue): void;
  /** @deprecated Push directly to `.issues` instead. */
  addIssues(issues: $ZodIssue[]): void;
  /** @deprecated Check `err.issues.length === 0` instead. */
  isEmpty: boolean;
}
declare const ZodError: $constructor<ZodError>;
declare const ZodRealError: $constructor<ZodError>;
/** @deprecated Use `z.core.$ZodRawIssue` instead. */
type IssueData = $ZodRawIssue;
//#endregion
//#region node_modules/zod/v4/classic/parse.d.cts
type ZodSafeParseResult<T> = ZodSafeParseSuccess<T> | ZodSafeParseError<T>;
type ZodSafeParseSuccess<T> = {
  success: true;
  data: T;
  error?: never;
};
type ZodSafeParseError<T> = {
  success: false;
  data?: never;
  error: ZodError<T>;
};
declare const parse: <T extends $ZodType>(schema: T, value: unknown, _ctx?: ParseContext<$ZodIssue>, _params?: {
  callee?: AnyFunc;
  Err?: $ZodErrorClass;
}) => output<T>;
declare const parseAsync: <T extends $ZodType>(schema: T, value: unknown, _ctx?: ParseContext<$ZodIssue>, _params?: {
  callee?: AnyFunc;
  Err?: $ZodErrorClass;
}) => Promise<output<T>>;
declare const safeParse: <T extends $ZodType>(schema: T, value: unknown, _ctx?: ParseContext<$ZodIssue>) => ZodSafeParseResult<output<T>>;
declare const safeParseAsync: <T extends $ZodType>(schema: T, value: unknown, _ctx?: ParseContext<$ZodIssue>) => Promise<ZodSafeParseResult<output<T>>>;
declare const encode: <T extends $ZodType>(schema: T, value: output<T>, _ctx?: ParseContext<$ZodIssue>) => input<T>;
declare const decode: <T extends $ZodType>(schema: T, value: input<T>, _ctx?: ParseContext<$ZodIssue>) => output<T>;
declare const encodeAsync: <T extends $ZodType>(schema: T, value: output<T>, _ctx?: ParseContext<$ZodIssue>) => Promise<input<T>>;
declare const decodeAsync: <T extends $ZodType>(schema: T, value: input<T>, _ctx?: ParseContext<$ZodIssue>) => Promise<output<T>>;
declare const safeEncode: <T extends $ZodType>(schema: T, value: output<T>, _ctx?: ParseContext<$ZodIssue>) => ZodSafeParseResult<input<T>>;
declare const safeDecode: <T extends $ZodType>(schema: T, value: input<T>, _ctx?: ParseContext<$ZodIssue>) => ZodSafeParseResult<output<T>>;
declare const safeEncodeAsync: <T extends $ZodType>(schema: T, value: output<T>, _ctx?: ParseContext<$ZodIssue>) => Promise<ZodSafeParseResult<input<T>>>;
declare const safeDecodeAsync: <T extends $ZodType>(schema: T, value: input<T>, _ctx?: ParseContext<$ZodIssue>) => Promise<ZodSafeParseResult<output<T>>>;
//#endregion
//#region node_modules/zod/v4/classic/schemas.d.cts
type ZodStandardSchemaWithJSON<T> = StandardSchemaWithJSONProps<input<T>, output<T>>;
interface ZodType<out Output = unknown, out Input = unknown, out Internals extends $ZodTypeInternals<Output, Input> = $ZodTypeInternals<Output, Input>> extends $ZodType<Output, Input, Internals> {
  def: Internals["def"];
  type: Internals["def"]["type"];
  /** @deprecated Use `.def` instead. */
  _def: Internals["def"];
  /** @deprecated Use `z.output<typeof schema>` instead. */
  _output: Internals["output"];
  /** @deprecated Use `z.input<typeof schema>` instead. */
  _input: Internals["input"];
  "~standard": ZodStandardSchemaWithJSON<this>;
  /** Converts this schema to a JSON Schema representation. */
  toJSONSchema(params?: ToJSONSchemaParams): ZodStandardJSONSchemaPayload<this>;
  check(...checks: (CheckFn<output<this>> | $ZodCheck<output<this>>)[]): this;
  with(...checks: (CheckFn<output<this>> | $ZodCheck<output<this>>)[]): this;
  clone(def?: Internals["def"], params?: {
    parent: boolean;
  }): this;
  register<R extends $ZodRegistry>(registry: R, ...meta: this extends R["_schema"] ? undefined extends R["_meta"] ? [$replace<R["_meta"], this>?] : [$replace<R["_meta"], this>] : ["Incompatible schema"]): this;
  brand<T extends PropertyKey = PropertyKey, Dir extends "in" | "out" | "inout" = "out">(value?: T): PropertyKey extends T ? this : $ZodBranded<this, T, Dir>;
  parse(data: unknown, params?: ParseContext<$ZodIssue>): output<this>;
  safeParse(data: unknown, params?: ParseContext<$ZodIssue>): ZodSafeParseResult<output<this>>;
  parseAsync(data: unknown, params?: ParseContext<$ZodIssue>): Promise<output<this>>;
  safeParseAsync(data: unknown, params?: ParseContext<$ZodIssue>): Promise<ZodSafeParseResult<output<this>>>;
  spa: (data: unknown, params?: ParseContext<$ZodIssue>) => Promise<ZodSafeParseResult<output<this>>>;
  encode(data: output<this>, params?: ParseContext<$ZodIssue>): input<this>;
  decode(data: input<this>, params?: ParseContext<$ZodIssue>): output<this>;
  encodeAsync(data: output<this>, params?: ParseContext<$ZodIssue>): Promise<input<this>>;
  decodeAsync(data: input<this>, params?: ParseContext<$ZodIssue>): Promise<output<this>>;
  safeEncode(data: output<this>, params?: ParseContext<$ZodIssue>): ZodSafeParseResult<input<this>>;
  safeDecode(data: input<this>, params?: ParseContext<$ZodIssue>): ZodSafeParseResult<output<this>>;
  safeEncodeAsync(data: output<this>, params?: ParseContext<$ZodIssue>): Promise<ZodSafeParseResult<input<this>>>;
  safeDecodeAsync(data: input<this>, params?: ParseContext<$ZodIssue>): Promise<ZodSafeParseResult<output<this>>>;
  refine<Ch extends (arg: output<this>) => unknown | Promise<unknown>>(check: Ch, params?: string | $ZodCustomParams): Ch extends ((arg: any) => arg is infer R) ? this & ZodType<R, input<this>> : this;
  superRefine(refinement: (arg: output<this>, ctx: $RefinementCtx<output<this>>) => void | Promise<void>, params?: $ZodSuperRefineParams): this;
  overwrite(fn: (x: output<this>) => output<this>): this;
  optional(): ZodOptional<this>;
  exactOptional(): ZodExactOptional<this>;
  nonoptional(params?: string | $ZodNonOptionalParams): ZodNonOptional<this>;
  nullable(): ZodNullable<this>;
  nullish(): ZodOptional<ZodNullable<this>>;
  default(def: NoUndefined<output<this>>): ZodDefault<this>;
  default(def: () => NoUndefined<output<this>>): ZodDefault<this>;
  prefault(def: () => input<this>): ZodPrefault<this>;
  prefault(def: input<this>): ZodPrefault<this>;
  array(): ZodArray<this>;
  or<T extends SomeType>(option: T): ZodUnion<[this, T]>;
  and<T extends SomeType>(incoming: T): ZodIntersection<this, T>;
  transform<NewOut>(transform: (arg: output<this>, ctx: $RefinementCtx<output<this>>) => NewOut | Promise<NewOut>): ZodPipe<this, ZodTransform<Awaited<NewOut>, output<this>>>;
  catch(def: output<this>): ZodCatch<this>;
  catch(def: (ctx: $ZodCatchCtx) => output<this>): ZodCatch<this>;
  pipe<T extends $ZodType<any, output<this>>>(target: T | $ZodType<any, output<this>>): ZodPipe<this, T>;
  readonly(): ZodReadonly<this>;
  /** Returns a new instance that has been registered in `z.globalRegistry` with the specified description */
  describe(description: string): this;
  description?: string;
  /** Returns the metadata associated with this instance in `z.globalRegistry` */
  meta(): $replace<GlobalMeta, this> | undefined;
  /** Returns a new instance that has been registered in `z.globalRegistry` with the specified metadata */
  meta(data: $replace<GlobalMeta, this>): this;
  /** @deprecated Try safe-parsing `undefined` (this is what `isOptional` does internally):
   *
   * ```ts
   * const schema = z.string().optional();
   * const isOptional = schema.safeParse(undefined).success; // true
   * ```
   */
  isOptional(): boolean;
  /**
   * @deprecated Try safe-parsing `null` (this is what `isNullable` does internally):
   *
   * ```ts
   * const schema = z.string().nullable();
   * const isNullable = schema.safeParse(null).success; // true
   * ```
   */
  isNullable(): boolean;
  apply<T>(fn: (schema: this) => T): T;
}
interface _ZodType<out Internals extends $ZodTypeInternals = $ZodTypeInternals> extends ZodType<any, any, Internals> {}
declare const ZodType: $constructor<ZodType>;
interface _ZodString<T extends $ZodStringInternals<unknown> = $ZodStringInternals<unknown>> extends _ZodType<T> {
  format: string | null;
  minLength: number | null;
  maxLength: number | null;
  regex(regex: RegExp, params?: string | $ZodCheckRegexParams): this;
  includes(value: string, params?: string | $ZodCheckIncludesParams): this;
  startsWith(value: string, params?: string | $ZodCheckStartsWithParams): this;
  endsWith(value: string, params?: string | $ZodCheckEndsWithParams): this;
  min(minLength: number, params?: string | $ZodCheckMinLengthParams): this;
  max(maxLength: number, params?: string | $ZodCheckMaxLengthParams): this;
  length(len: number, params?: string | $ZodCheckLengthEqualsParams): this;
  nonempty(params?: string | $ZodCheckMinLengthParams): this;
  lowercase(params?: string | $ZodCheckLowerCaseParams): this;
  uppercase(params?: string | $ZodCheckUpperCaseParams): this;
  trim(): this;
  normalize(form?: "NFC" | "NFD" | "NFKC" | "NFKD" | (string & {})): this;
  toLowerCase(): this;
  toUpperCase(): this;
  slugify(): this;
}
/** @internal */
declare const _ZodString: $constructor<_ZodString>;
interface ZodString extends _ZodString<$ZodStringInternals<string>> {
  /** @deprecated Use `z.email()` instead. */
  email(params?: string | $ZodCheckEmailParams): this;
  /** @deprecated Use `z.url()` instead. */
  url(params?: string | $ZodCheckURLParams): this;
  /** @deprecated Use `z.jwt()` instead. */
  jwt(params?: string | $ZodCheckJWTParams): this;
  /** @deprecated Use `z.emoji()` instead. */
  emoji(params?: string | $ZodCheckEmojiParams): this;
  /** @deprecated Use `z.guid()` instead. */
  guid(params?: string | $ZodCheckGUIDParams): this;
  /** @deprecated Use `z.uuid()` instead. */
  uuid(params?: string | $ZodCheckUUIDParams): this;
  /** @deprecated Use `z.uuid()` instead. */
  uuidv4(params?: string | $ZodCheckUUIDParams): this;
  /** @deprecated Use `z.uuid()` instead. */
  uuidv6(params?: string | $ZodCheckUUIDParams): this;
  /** @deprecated Use `z.uuid()` instead. */
  uuidv7(params?: string | $ZodCheckUUIDParams): this;
  /** @deprecated Use `z.nanoid()` instead. */
  nanoid(params?: string | $ZodCheckNanoIDParams): this;
  /** @deprecated Use `z.guid()` instead. */
  guid(params?: string | $ZodCheckGUIDParams): this;
  /**
   * @deprecated CUID v1 is deprecated by its authors due to information leakage
   * (timestamps embedded in the id). Use `z.cuid2()` instead.
   * See https://github.com/paralleldrive/cuid.
   */
  cuid(params?: string | $ZodCheckCUIDParams): this;
  /** @deprecated Use `z.cuid2()` instead. */
  cuid2(params?: string | $ZodCheckCUID2Params): this;
  /** @deprecated Use `z.ulid()` instead. */
  ulid(params?: string | $ZodCheckULIDParams): this;
  /** @deprecated Use `z.base64()` instead. */
  base64(params?: string | $ZodCheckBase64Params): this;
  /** @deprecated Use `z.base64url()` instead. */
  base64url(params?: string | $ZodCheckBase64URLParams): this;
  /** @deprecated Use `z.xid()` instead. */
  xid(params?: string | $ZodCheckXIDParams): this;
  /** @deprecated Use `z.ksuid()` instead. */
  ksuid(params?: string | $ZodCheckKSUIDParams): this;
  /** @deprecated Use `z.ipv4()` instead. */
  ipv4(params?: string | $ZodCheckIPv4Params): this;
  /** @deprecated Use `z.ipv6()` instead. */
  ipv6(params?: string | $ZodCheckIPv6Params): this;
  /** @deprecated Use `z.cidrv4()` instead. */
  cidrv4(params?: string | $ZodCheckCIDRv4Params): this;
  /** @deprecated Use `z.cidrv6()` instead. */
  cidrv6(params?: string | $ZodCheckCIDRv6Params): this;
  /** @deprecated Use `z.e164()` instead. */
  e164(params?: string | $ZodCheckE164Params): this;
  /** @deprecated Use `z.iso.datetime()` instead. */
  datetime(params?: string | $ZodCheckISODateTimeParams): this;
  /** @deprecated Use `z.iso.date()` instead. */
  date(params?: string | $ZodCheckISODateParams): this;
  /** @deprecated Use `z.iso.time()` instead. */
  time(params?: string | $ZodCheckISOTimeParams): this;
  /** @deprecated Use `z.iso.duration()` instead. */
  duration(params?: string | $ZodCheckISODurationParams): this;
}
declare const ZodString: $constructor<ZodString>;
declare function string(params?: string | $ZodStringParams): ZodString;
declare function string<T extends string>(params?: string | $ZodStringParams): $ZodType<T, T>;
interface ZodStringFormat<Format extends string = string> extends _ZodString<$ZodStringFormatInternals<Format>> {}
declare const ZodStringFormat: $constructor<ZodStringFormat>;
interface ZodEmail extends ZodStringFormat<"email"> {
  _zod: $ZodEmailInternals;
}
declare const ZodEmail: $constructor<ZodEmail>;
declare function email(params?: string | $ZodEmailParams): ZodEmail;
interface ZodGUID extends ZodStringFormat<"guid"> {
  _zod: $ZodGUIDInternals;
}
declare const ZodGUID: $constructor<ZodGUID>;
declare function guid(params?: string | $ZodGUIDParams): ZodGUID;
interface ZodUUID extends ZodStringFormat<"uuid"> {
  _zod: $ZodUUIDInternals;
}
declare const ZodUUID: $constructor<ZodUUID>;
declare function uuid(params?: string | $ZodUUIDParams): ZodUUID;
declare function uuidv4(params?: string | $ZodUUIDv4Params): ZodUUID;
declare function uuidv6(params?: string | $ZodUUIDv6Params): ZodUUID;
declare function uuidv7(params?: string | $ZodUUIDv7Params): ZodUUID;
interface ZodURL extends ZodStringFormat<"url"> {
  _zod: $ZodURLInternals;
}
declare const ZodURL: $constructor<ZodURL>;
declare function url(params?: string | $ZodURLParams): ZodURL;
declare function httpUrl(params?: string | Omit<$ZodURLParams, "protocol" | "hostname">): ZodURL;
interface ZodEmoji extends ZodStringFormat<"emoji"> {
  _zod: $ZodEmojiInternals;
}
declare const ZodEmoji: $constructor<ZodEmoji>;
declare function emoji(params?: string | $ZodEmojiParams): ZodEmoji;
interface ZodNanoID extends ZodStringFormat<"nanoid"> {
  _zod: $ZodNanoIDInternals;
}
declare const ZodNanoID: $constructor<ZodNanoID>;
declare function nanoid(params?: string | $ZodNanoIDParams): ZodNanoID;
/**
 * @deprecated CUID v1 is deprecated by its authors due to information leakage
 * (timestamps embedded in the id). Use {@link ZodCUID2} instead.
 * See https://github.com/paralleldrive/cuid.
 */
interface ZodCUID extends ZodStringFormat<"cuid"> {
  _zod: $ZodCUIDInternals;
}
/**
 * @deprecated CUID v1 is deprecated by its authors due to information leakage
 * (timestamps embedded in the id). Use {@link ZodCUID2} instead.
 * See https://github.com/paralleldrive/cuid.
 */
declare const ZodCUID: $constructor<ZodCUID>;
/**
 * Validates a CUID v1 string.
 *
 * @deprecated CUID v1 is deprecated by its authors due to information leakage
 * (timestamps embedded in the id). Use {@link cuid2 | `z.cuid2()`} instead.
 * See https://github.com/paralleldrive/cuid.
 */
declare function cuid(params?: string | $ZodCUIDParams): ZodCUID;
interface ZodCUID2 extends ZodStringFormat<"cuid2"> {
  _zod: $ZodCUID2Internals;
}
declare const ZodCUID2: $constructor<ZodCUID2>;
declare function cuid2(params?: string | $ZodCUID2Params): ZodCUID2;
interface ZodULID extends ZodStringFormat<"ulid"> {
  _zod: $ZodULIDInternals;
}
declare const ZodULID: $constructor<ZodULID>;
declare function ulid(params?: string | $ZodULIDParams): ZodULID;
interface ZodXID extends ZodStringFormat<"xid"> {
  _zod: $ZodXIDInternals;
}
declare const ZodXID: $constructor<ZodXID>;
declare function xid(params?: string | $ZodXIDParams): ZodXID;
interface ZodKSUID extends ZodStringFormat<"ksuid"> {
  _zod: $ZodKSUIDInternals;
}
declare const ZodKSUID: $constructor<ZodKSUID>;
declare function ksuid(params?: string | $ZodKSUIDParams): ZodKSUID;
interface ZodIPv4 extends ZodStringFormat<"ipv4"> {
  _zod: $ZodIPv4Internals;
}
declare const ZodIPv4: $constructor<ZodIPv4>;
declare function ipv4(params?: string | $ZodIPv4Params): ZodIPv4;
interface ZodMAC extends ZodStringFormat<"mac"> {
  _zod: $ZodMACInternals;
}
declare const ZodMAC: $constructor<ZodMAC>;
declare function mac(params?: string | $ZodMACParams): ZodMAC;
interface ZodIPv6 extends ZodStringFormat<"ipv6"> {
  _zod: $ZodIPv6Internals;
}
declare const ZodIPv6: $constructor<ZodIPv6>;
declare function ipv6(params?: string | $ZodIPv6Params): ZodIPv6;
interface ZodCIDRv4 extends ZodStringFormat<"cidrv4"> {
  _zod: $ZodCIDRv4Internals;
}
declare const ZodCIDRv4: $constructor<ZodCIDRv4>;
declare function cidrv4(params?: string | $ZodCIDRv4Params): ZodCIDRv4;
interface ZodCIDRv6 extends ZodStringFormat<"cidrv6"> {
  _zod: $ZodCIDRv6Internals;
}
declare const ZodCIDRv6: $constructor<ZodCIDRv6>;
declare function cidrv6(params?: string | $ZodCIDRv6Params): ZodCIDRv6;
interface ZodBase64 extends ZodStringFormat<"base64"> {
  _zod: $ZodBase64Internals;
}
declare const ZodBase64: $constructor<ZodBase64>;
declare function base64(params?: string | $ZodBase64Params): ZodBase64;
interface ZodBase64URL extends ZodStringFormat<"base64url"> {
  _zod: $ZodBase64URLInternals;
}
declare const ZodBase64URL: $constructor<ZodBase64URL>;
declare function base64url(params?: string | $ZodBase64URLParams): ZodBase64URL;
interface ZodE164 extends ZodStringFormat<"e164"> {
  _zod: $ZodE164Internals;
}
declare const ZodE164: $constructor<ZodE164>;
declare function e164(params?: string | $ZodE164Params): ZodE164;
interface ZodJWT extends ZodStringFormat<"jwt"> {
  _zod: $ZodJWTInternals;
}
declare const ZodJWT: $constructor<ZodJWT>;
declare function jwt(params?: string | $ZodJWTParams): ZodJWT;
interface ZodCustomStringFormat<Format extends string = string> extends ZodStringFormat<Format>, $ZodCustomStringFormat<Format> {
  _zod: $ZodCustomStringFormatInternals<Format>;
  "~standard": ZodStandardSchemaWithJSON<this>;
}
declare const ZodCustomStringFormat: $constructor<ZodCustomStringFormat>;
declare function stringFormat<Format extends string>(format: Format, fnOrRegex: ((arg: string) => MaybeAsync<unknown>) | RegExp, _params?: string | $ZodStringFormatParams): ZodCustomStringFormat<Format>;
declare function hostname(_params?: string | $ZodStringFormatParams): ZodCustomStringFormat<"hostname">;
declare function hex(_params?: string | $ZodStringFormatParams): ZodCustomStringFormat<"hex">;
declare function hash<Alg extends HashAlgorithm, Enc extends HashEncoding = "hex">(alg: Alg, params?: {
  enc?: Enc;
} & $ZodStringFormatParams): ZodCustomStringFormat<`${Alg}_${Enc}`>;
interface _ZodNumber<Internals extends $ZodNumberInternals = $ZodNumberInternals> extends _ZodType<Internals> {
  gt(value: number, params?: string | $ZodCheckGreaterThanParams): this;
  /** Identical to .min() */
  gte(value: number, params?: string | $ZodCheckGreaterThanParams): this;
  min(value: number, params?: string | $ZodCheckGreaterThanParams): this;
  lt(value: number, params?: string | $ZodCheckLessThanParams): this;
  /** Identical to .max() */
  lte(value: number, params?: string | $ZodCheckLessThanParams): this;
  max(value: number, params?: string | $ZodCheckLessThanParams): this;
  /** Consider `z.int()` instead. This API is considered *legacy*; it will never be removed but a better alternative exists. */
  int(params?: string | $ZodCheckNumberFormatParams): this;
  /** @deprecated This is now identical to `.int()`. Only numbers in the safe integer range are accepted. */
  safe(params?: string | $ZodCheckNumberFormatParams): this;
  positive(params?: string | $ZodCheckGreaterThanParams): this;
  nonnegative(params?: string | $ZodCheckGreaterThanParams): this;
  negative(params?: string | $ZodCheckLessThanParams): this;
  nonpositive(params?: string | $ZodCheckLessThanParams): this;
  multipleOf(value: number, params?: string | $ZodCheckMultipleOfParams): this;
  /** @deprecated Use `.multipleOf()` instead. */
  step(value: number, params?: string | $ZodCheckMultipleOfParams): this;
  /** @deprecated In v4 and later, z.number() does not allow infinite values by default. This is a no-op. */
  finite(params?: unknown): this;
  minValue: number | null;
  maxValue: number | null;
  /** @deprecated Check the `format` property instead.  */
  isInt: boolean;
  /** @deprecated Number schemas no longer accept infinite values, so this always returns `true`. */
  isFinite: boolean;
  format: string | null;
}
interface ZodNumber extends _ZodNumber<$ZodNumberInternals<number>> {}
declare const ZodNumber: $constructor<ZodNumber>;
declare function number(params?: string | $ZodNumberParams): ZodNumber;
interface ZodNumberFormat extends ZodNumber {
  _zod: $ZodNumberFormatInternals;
}
declare const ZodNumberFormat: $constructor<ZodNumberFormat>;
interface ZodInt extends ZodNumberFormat {}
declare function int(params?: string | $ZodCheckNumberFormatParams): ZodInt;
interface ZodFloat32 extends ZodNumberFormat {}
declare function float32(params?: string | $ZodCheckNumberFormatParams): ZodFloat32;
interface ZodFloat64 extends ZodNumberFormat {}
declare function float64(params?: string | $ZodCheckNumberFormatParams): ZodFloat64;
interface ZodInt32 extends ZodNumberFormat {}
declare function int32(params?: string | $ZodCheckNumberFormatParams): ZodInt32;
interface ZodUInt32 extends ZodNumberFormat {}
declare function uint32(params?: string | $ZodCheckNumberFormatParams): ZodUInt32;
interface _ZodBoolean<T extends $ZodBooleanInternals = $ZodBooleanInternals> extends _ZodType<T> {}
interface ZodBoolean extends _ZodBoolean<$ZodBooleanInternals<boolean>> {}
declare const ZodBoolean: $constructor<ZodBoolean>;
declare function boolean(params?: string | $ZodBooleanParams): ZodBoolean;
interface _ZodBigInt<T extends $ZodBigIntInternals = $ZodBigIntInternals> extends _ZodType<T> {
  gte(value: bigint, params?: string | $ZodCheckGreaterThanParams): this;
  /** Alias of `.gte()` */
  min(value: bigint, params?: string | $ZodCheckGreaterThanParams): this;
  gt(value: bigint, params?: string | $ZodCheckGreaterThanParams): this;
  /** Alias of `.lte()` */
  lte(value: bigint, params?: string | $ZodCheckLessThanParams): this;
  max(value: bigint, params?: string | $ZodCheckLessThanParams): this;
  lt(value: bigint, params?: string | $ZodCheckLessThanParams): this;
  positive(params?: string | $ZodCheckGreaterThanParams): this;
  negative(params?: string | $ZodCheckLessThanParams): this;
  nonpositive(params?: string | $ZodCheckLessThanParams): this;
  nonnegative(params?: string | $ZodCheckGreaterThanParams): this;
  multipleOf(value: bigint, params?: string | $ZodCheckMultipleOfParams): this;
  minValue: bigint | null;
  maxValue: bigint | null;
  format: string | null;
}
interface ZodBigInt extends _ZodBigInt<$ZodBigIntInternals<bigint>> {}
declare const ZodBigInt: $constructor<ZodBigInt>;
declare function bigint(params?: string | $ZodBigIntParams): ZodBigInt;
interface ZodBigIntFormat extends ZodBigInt {
  _zod: $ZodBigIntFormatInternals;
}
declare const ZodBigIntFormat: $constructor<ZodBigIntFormat>;
declare function int64(params?: string | $ZodBigIntFormatParams): ZodBigIntFormat;
declare function uint64(params?: string | $ZodBigIntFormatParams): ZodBigIntFormat;
interface ZodSymbol extends _ZodType<$ZodSymbolInternals> {}
declare const ZodSymbol: $constructor<ZodSymbol>;
declare function symbol(params?: string | $ZodSymbolParams): ZodSymbol;
interface ZodUndefined extends _ZodType<$ZodUndefinedInternals> {}
declare const ZodUndefined: $constructor<ZodUndefined>;
declare function _undefined(params?: string | $ZodUndefinedParams): ZodUndefined;
interface ZodNull extends _ZodType<$ZodNullInternals> {}
declare const ZodNull: $constructor<ZodNull>;
declare function _null(params?: string | $ZodNullParams): ZodNull;
interface ZodAny extends _ZodType<$ZodAnyInternals> {}
declare const ZodAny: $constructor<ZodAny>;
declare function any(): ZodAny;
interface ZodUnknown extends _ZodType<$ZodUnknownInternals> {}
declare const ZodUnknown: $constructor<ZodUnknown>;
declare function unknown(): ZodUnknown;
interface ZodNever extends _ZodType<$ZodNeverInternals> {}
declare const ZodNever: $constructor<ZodNever>;
declare function never(params?: string | $ZodNeverParams): ZodNever;
interface ZodVoid extends _ZodType<$ZodVoidInternals> {}
declare const ZodVoid: $constructor<ZodVoid>;
declare function _void(params?: string | $ZodVoidParams): ZodVoid;
interface _ZodDate<T extends $ZodDateInternals = $ZodDateInternals> extends _ZodType<T> {
  min(value: number | Date, params?: string | $ZodCheckGreaterThanParams): this;
  max(value: number | Date, params?: string | $ZodCheckLessThanParams): this;
  /** @deprecated Not recommended. */
  minDate: Date | null;
  /** @deprecated Not recommended. */
  maxDate: Date | null;
}
interface ZodDate extends _ZodDate<$ZodDateInternals<Date>> {}
declare const ZodDate: $constructor<ZodDate>;
declare function date(params?: string | $ZodDateParams): ZodDate;
interface ZodArray<T extends SomeType = $ZodType> extends _ZodType<$ZodArrayInternals<T>>, $ZodArray<T> {
  element: T;
  min(minLength: number, params?: string | $ZodCheckMinLengthParams): this;
  nonempty(params?: string | $ZodCheckMinLengthParams): this;
  max(maxLength: number, params?: string | $ZodCheckMaxLengthParams): this;
  length(len: number, params?: string | $ZodCheckLengthEqualsParams): this;
  unwrap(): T;
  "~standard": ZodStandardSchemaWithJSON<this>;
}
declare const ZodArray: $constructor<ZodArray>;
declare function array<T extends SomeType>(element: T, params?: string | $ZodArrayParams): ZodArray<T>;
declare function keyof<T extends ZodObject>(schema: T): ZodEnum<KeysEnum<T["_zod"]["output"]>>;
type SafeExtendShape<Base extends $ZodShape, Ext extends $ZodLooseShape> = { [K in keyof Ext]: K extends keyof Base ? output<Ext[K]> extends output<Base[K]> ? input<Ext[K]> extends input<Base[K]> ? Ext[K] : never : never : Ext[K] };
interface ZodObject< /** @ts-ignore Cast variance */out Shape extends $ZodShape = $ZodLooseShape, out Config extends $ZodObjectConfig = $strip> extends _ZodType<$ZodObjectInternals<Shape, Config>>, $ZodObject<Shape, Config> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  shape: Shape;
  keyof(): ZodEnum<ToEnum<keyof Shape & string>>;
  /** Define a schema to validate all unrecognized keys. This overrides the existing strict/loose behavior. */
  catchall<T extends SomeType>(schema: T): ZodObject<Shape, $catchall<T>>;
  /** @deprecated Use `z.looseObject()` or `.loose()` instead. */
  passthrough(): ZodObject<Shape, $loose>;
  /** Consider `z.looseObject(A.shape)` instead */
  loose(): ZodObject<Shape, $loose>;
  /** Consider `z.strictObject(A.shape)` instead */
  strict(): ZodObject<Shape, $strict>;
  /** This is the default behavior. This method call is likely unnecessary. */
  strip(): ZodObject<Shape, $strip>;
  extend<U extends $ZodLooseShape>(shape: U): ZodObject<Extend<Shape, Writeable<U>>, Config>;
  safeExtend<U extends $ZodLooseShape>(shape: SafeExtendShape<Shape, U> & Partial<Record<keyof Shape, SomeType>>): ZodObject<Extend<Shape, Writeable<U>>, Config>;
  /**
   * @deprecated Use [`A.extend(B.shape)`](https://zod.dev/api?id=extend) instead.
   */
  merge<U extends ZodObject>(other: U): ZodObject<Extend<Shape, U["shape"]>, U["_zod"]["config"]>;
  pick<M extends Mask<keyof Shape>>(mask: M & Record<Exclude<keyof M, keyof Shape>, never>): ZodObject<Flatten<Pick<Shape, Extract<keyof Shape, keyof M>>>, Config>;
  omit<M extends Mask<keyof Shape>>(mask: M & Record<Exclude<keyof M, keyof Shape>, never>): ZodObject<Flatten<Omit<Shape, Extract<keyof Shape, keyof M>>>, Config>;
  partial(): ZodObject<{ -readonly [k in keyof Shape]: ZodOptional<Shape[k]> }, Config>;
  partial<M extends Mask<keyof Shape>>(mask: M & Record<Exclude<keyof M, keyof Shape>, never>): ZodObject<{ -readonly [k in keyof Shape]: k extends keyof M ? ZodOptional<Shape[k]> : Shape[k] }, Config>;
  required(): ZodObject<{ -readonly [k in keyof Shape]: ZodNonOptional<Shape[k]> }, Config>;
  required<M extends Mask<keyof Shape>>(mask: M & Record<Exclude<keyof M, keyof Shape>, never>): ZodObject<{ -readonly [k in keyof Shape]: k extends keyof M ? ZodNonOptional<Shape[k]> : Shape[k] }, Config>;
}
declare const ZodObject: $constructor<ZodObject>;
declare function object<T extends $ZodLooseShape = Partial<Record<never, SomeType>>>(shape?: T, params?: string | $ZodObjectParams): ZodObject<Writeable<T>, $strip>;
declare function strictObject<T extends $ZodLooseShape>(shape: T, params?: string | $ZodObjectParams): ZodObject<Writeable<T>, $strict>;
declare function looseObject<T extends $ZodLooseShape>(shape: T, params?: string | $ZodObjectParams): ZodObject<Writeable<T>, $loose>;
interface ZodUnion<T extends readonly SomeType[] = readonly $ZodType[]> extends _ZodType<$ZodUnionInternals<T>>, $ZodUnion<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  options: T;
}
declare const ZodUnion: $constructor<ZodUnion>;
declare function union<const T extends readonly SomeType[]>(options: T, params?: string | $ZodUnionParams): ZodUnion<T>;
interface ZodXor<T extends readonly SomeType[] = readonly $ZodType[]> extends _ZodType<$ZodXorInternals<T>>, $ZodXor<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  options: T;
}
declare const ZodXor: $constructor<ZodXor>;
/** Creates an exclusive union (XOR) where exactly one option must match.
 * Unlike regular unions that succeed when any option matches, xor fails if
 * zero or more than one option matches the input. */
declare function xor<const T extends readonly SomeType[]>(options: T, params?: string | $ZodXorParams): ZodXor<T>;
interface ZodDiscriminatedUnion<Options extends readonly SomeType[] = readonly $ZodType[], Disc extends string = string> extends ZodUnion<Options>, $ZodDiscriminatedUnion<Options, Disc> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  _zod: $ZodDiscriminatedUnionInternals<Options, Disc>;
  def: $ZodDiscriminatedUnionDef<Options, Disc>;
}
declare const ZodDiscriminatedUnion: $constructor<ZodDiscriminatedUnion>;
declare function discriminatedUnion<Types extends readonly [$ZodTypeDiscriminable<Disc>, ...$ZodTypeDiscriminable<Disc>[]], Disc extends string>(discriminator: Disc, options: Types, params?: string | $ZodDiscriminatedUnionParams): ZodDiscriminatedUnion<Types, Disc>;
interface ZodIntersection<A extends SomeType = $ZodType, B extends SomeType = $ZodType> extends _ZodType<$ZodIntersectionInternals<A, B>>, $ZodIntersection<A, B> {
  "~standard": ZodStandardSchemaWithJSON<this>;
}
declare const ZodIntersection: $constructor<ZodIntersection>;
declare function intersection<T extends SomeType, U extends SomeType>(left: T, right: U): ZodIntersection<T, U>;
interface ZodTuple<T extends TupleItems = readonly $ZodType[], Rest extends SomeType | null = $ZodType | null> extends _ZodType<$ZodTupleInternals<T, Rest>>, $ZodTuple<T, Rest> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  rest<Rest extends SomeType = $ZodType>(rest: Rest): ZodTuple<T, Rest>;
}
declare const ZodTuple: $constructor<ZodTuple>;
declare function tuple<T extends readonly [SomeType, ...SomeType[]]>(items: T, params?: string | $ZodTupleParams): ZodTuple<T, null>;
declare function tuple<T extends readonly [SomeType, ...SomeType[]], Rest extends SomeType>(items: T, rest: Rest, params?: string | $ZodTupleParams): ZodTuple<T, Rest>;
declare function tuple(items: [], params?: string | $ZodTupleParams): ZodTuple<[], null>;
interface ZodRecord<Key extends $ZodRecordKey = $ZodRecordKey, Value extends SomeType = $ZodType> extends _ZodType<$ZodRecordInternals<Key, Value>>, $ZodRecord<Key, Value> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  keyType: Key;
  valueType: Value;
}
declare const ZodRecord: $constructor<ZodRecord>;
declare function record<Key extends $ZodRecordKey, Value extends SomeType>(keyType: Key, valueType: Value, params?: string | $ZodRecordParams): ZodRecord<Key, Value>;
declare function partialRecord<Key extends $ZodRecordKey, Value extends SomeType>(keyType: Key, valueType: Value, params?: string | $ZodRecordParams): ZodRecord<Key & $partial, Value>;
declare function looseRecord<Key extends $ZodRecordKey, Value extends SomeType>(keyType: Key, valueType: Value, params?: string | $ZodRecordParams): ZodRecord<Key, Value>;
interface ZodMap<Key extends SomeType = $ZodType, Value extends SomeType = $ZodType> extends _ZodType<$ZodMapInternals<Key, Value>>, $ZodMap<Key, Value> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  keyType: Key;
  valueType: Value;
  min(minSize: number, params?: string | $ZodCheckMinSizeParams): this;
  nonempty(params?: string | $ZodCheckMinSizeParams): this;
  max(maxSize: number, params?: string | $ZodCheckMaxSizeParams): this;
  size(size: number, params?: string | $ZodCheckSizeEqualsParams): this;
}
declare const ZodMap: $constructor<ZodMap>;
declare function map<Key extends SomeType, Value extends SomeType>(keyType: Key, valueType: Value, params?: string | $ZodMapParams): ZodMap<Key, Value>;
interface ZodSet<T extends SomeType = $ZodType> extends _ZodType<$ZodSetInternals<T>>, $ZodSet<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  min(minSize: number, params?: string | $ZodCheckMinSizeParams): this;
  nonempty(params?: string | $ZodCheckMinSizeParams): this;
  max(maxSize: number, params?: string | $ZodCheckMaxSizeParams): this;
  size(size: number, params?: string | $ZodCheckSizeEqualsParams): this;
}
declare const ZodSet: $constructor<ZodSet>;
declare function set<Value extends SomeType>(valueType: Value, params?: string | $ZodSetParams): ZodSet<Value>;
interface ZodEnum< /** @ts-ignore Cast variance */out T extends EnumLike = EnumLike> extends _ZodType<$ZodEnumInternals<T>>, $ZodEnum<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  enum: T;
  options: Array<T[keyof T]>;
  extract<const U extends readonly (keyof T)[]>(values: U, params?: string | $ZodEnumParams): ZodEnum<Flatten<Pick<T, U[number]>>>;
  exclude<const U extends readonly (keyof T)[]>(values: U, params?: string | $ZodEnumParams): ZodEnum<Flatten<Omit<T, U[number]>>>;
}
declare const ZodEnum: $constructor<ZodEnum>;
declare function _enum<const T extends readonly string[]>(values: T, params?: string | $ZodEnumParams): ZodEnum<ToEnum<T[number]>>;
declare function _enum<const T extends EnumLike>(entries: T, params?: string | $ZodEnumParams): ZodEnum<T>;
/** @deprecated This API has been merged into `z.enum()`. Use `z.enum()` instead.
 *
 * ```ts
 * enum Colors { red, green, blue }
 * z.enum(Colors);
 * ```
 */
declare function nativeEnum<T extends EnumLike>(entries: T, params?: string | $ZodEnumParams): ZodEnum<T>;
interface ZodLiteral<T extends Literal = Literal> extends _ZodType<$ZodLiteralInternals<T>>, $ZodLiteral<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  values: Set<T>;
  /** @legacy Use `.values` instead. Accessing this property will throw an error if the literal accepts multiple values. */
  value: T;
}
declare const ZodLiteral: $constructor<ZodLiteral>;
declare function literal<const T extends ReadonlyArray<Literal>>(value: T, params?: string | $ZodLiteralParams): ZodLiteral<T[number]>;
declare function literal<const T extends Literal>(value: T, params?: string | $ZodLiteralParams): ZodLiteral<T>;
interface ZodFile extends _ZodType<$ZodFileInternals>, $ZodFile {
  "~standard": ZodStandardSchemaWithJSON<this>;
  min(size: number, params?: string | $ZodCheckMinSizeParams): this;
  max(size: number, params?: string | $ZodCheckMaxSizeParams): this;
  mime(types: MimeTypes | Array<MimeTypes>, params?: string | $ZodCheckMimeTypeParams): this;
}
declare const ZodFile: $constructor<ZodFile>;
declare function file(params?: string | $ZodFileParams): ZodFile;
interface ZodTransform<O = unknown, I = unknown> extends _ZodType<$ZodTransformInternals<O, I>>, $ZodTransform<O, I> {
  "~standard": ZodStandardSchemaWithJSON<this>;
}
declare const ZodTransform: $constructor<ZodTransform>;
declare function transform<I = unknown, O = I>(fn: (input: I, ctx: $RefinementCtx) => O): ZodTransform<Awaited<O>, I>;
interface ZodOptional<T extends SomeType = $ZodType> extends _ZodType<$ZodOptionalInternals<T>>, $ZodOptional<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  unwrap(): T;
}
declare const ZodOptional: $constructor<ZodOptional>;
declare function optional<T extends SomeType>(innerType: T): ZodOptional<T>;
interface ZodExactOptional<T extends SomeType = $ZodType> extends _ZodType<$ZodExactOptionalInternals<T>>, $ZodExactOptional<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  unwrap(): T;
}
declare const ZodExactOptional: $constructor<ZodExactOptional>;
declare function exactOptional<T extends SomeType>(innerType: T): ZodExactOptional<T>;
interface ZodNullable<T extends SomeType = $ZodType> extends _ZodType<$ZodNullableInternals<T>>, $ZodNullable<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  unwrap(): T;
}
declare const ZodNullable: $constructor<ZodNullable>;
declare function nullable<T extends SomeType>(innerType: T): ZodNullable<T>;
declare function nullish<T extends SomeType>(innerType: T): ZodOptional<ZodNullable<T>>;
interface ZodDefault<T extends SomeType = $ZodType> extends _ZodType<$ZodDefaultInternals<T>>, $ZodDefault<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  unwrap(): T;
  /** @deprecated Use `.unwrap()` instead. */
  removeDefault(): T;
}
declare const ZodDefault: $constructor<ZodDefault>;
declare function _default<T extends SomeType>(innerType: T, defaultValue: NoUndefined<output<T>> | (() => NoUndefined<output<T>>)): ZodDefault<T>;
interface ZodPrefault<T extends SomeType = $ZodType> extends _ZodType<$ZodPrefaultInternals<T>>, $ZodPrefault<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  unwrap(): T;
}
declare const ZodPrefault: $constructor<ZodPrefault>;
declare function prefault<T extends SomeType>(innerType: T, defaultValue: input<T> | (() => input<T>)): ZodPrefault<T>;
interface ZodNonOptional<T extends SomeType = $ZodType> extends _ZodType<$ZodNonOptionalInternals<T>>, $ZodNonOptional<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  unwrap(): T;
}
declare const ZodNonOptional: $constructor<ZodNonOptional>;
declare function nonoptional<T extends SomeType>(innerType: T, params?: string | $ZodNonOptionalParams): ZodNonOptional<T>;
interface ZodSuccess<T extends SomeType = $ZodType> extends _ZodType<$ZodSuccessInternals<T>>, $ZodSuccess<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  unwrap(): T;
}
declare const ZodSuccess: $constructor<ZodSuccess>;
declare function success<T extends SomeType>(innerType: T): ZodSuccess<T>;
interface ZodCatch<T extends SomeType = $ZodType> extends _ZodType<$ZodCatchInternals<T>>, $ZodCatch<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  unwrap(): T;
  /** @deprecated Use `.unwrap()` instead. */
  removeCatch(): T;
}
declare const ZodCatch: $constructor<ZodCatch>;
declare function _catch<T extends SomeType>(innerType: T, catchValue: output<T> | ((ctx: $ZodCatchCtx) => output<T>)): ZodCatch<T>;
interface ZodNaN extends _ZodType<$ZodNaNInternals>, $ZodNaN {
  "~standard": ZodStandardSchemaWithJSON<this>;
}
declare const ZodNaN: $constructor<ZodNaN>;
declare function nan(params?: string | $ZodNaNParams): ZodNaN;
interface ZodPipe<A extends SomeType = $ZodType, B extends SomeType = $ZodType> extends _ZodType<$ZodPipeInternals<A, B>>, $ZodPipe<A, B> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  in: A;
  out: B;
}
declare const ZodPipe: $constructor<ZodPipe>;
declare function pipe<const A extends SomeType, B extends $ZodType<unknown, output<A>> = $ZodType<unknown, output<A>>>(in_: A, out: B | $ZodType<unknown, output<A>>): ZodPipe<A, B>;
interface ZodCodec<A extends SomeType = $ZodType, B extends SomeType = $ZodType> extends ZodPipe<A, B>, $ZodCodec<A, B> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  _zod: $ZodCodecInternals<A, B>;
  def: $ZodCodecDef<A, B>;
}
declare const ZodCodec: $constructor<ZodCodec>;
declare function codec<const A extends SomeType, B extends SomeType = $ZodType>(in_: A, out: B, params: {
  decode: (value: output<A>, payload: ParsePayload<output<A>>) => MaybeAsync<input<B>>;
  encode: (value: input<B>, payload: ParsePayload<input<B>>) => MaybeAsync<output<A>>;
}): ZodCodec<A, B>;
declare function invertCodec<A extends SomeType, B extends SomeType>(codec: ZodCodec<A, B>): ZodCodec<B, A>;
interface ZodPreprocess<B extends SomeType = $ZodType> extends ZodPipe<$ZodTransform, B>, $ZodPreprocess<B> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  _zod: $ZodPreprocessInternals<B>;
  def: $ZodPreprocessDef<B>;
}
declare const ZodPreprocess: $constructor<ZodPreprocess>;
interface ZodReadonly<T extends SomeType = $ZodType> extends _ZodType<$ZodReadonlyInternals<T>>, $ZodReadonly<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  unwrap(): T;
}
declare const ZodReadonly: $constructor<ZodReadonly>;
declare function readonly<T extends SomeType>(innerType: T): ZodReadonly<T>;
interface ZodTemplateLiteral<Template extends string = string> extends _ZodType<$ZodTemplateLiteralInternals<Template>>, $ZodTemplateLiteral<Template> {
  "~standard": ZodStandardSchemaWithJSON<this>;
}
declare const ZodTemplateLiteral: $constructor<ZodTemplateLiteral>;
declare function templateLiteral<const Parts extends $ZodTemplateLiteralPart[]>(parts: Parts, params?: string | $ZodTemplateLiteralParams): ZodTemplateLiteral<$PartsToTemplateLiteral<Parts>>;
interface ZodLazy<T extends SomeType = $ZodType> extends _ZodType<$ZodLazyInternals<T>>, $ZodLazy<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  unwrap(): T;
}
declare const ZodLazy: $constructor<ZodLazy>;
declare function lazy<T extends SomeType>(getter: () => T): ZodLazy<T>;
interface ZodPromise<T extends SomeType = $ZodType> extends _ZodType<$ZodPromiseInternals<T>>, $ZodPromise<T> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  unwrap(): T;
}
declare const ZodPromise: $constructor<ZodPromise>;
declare function promise<T extends SomeType>(innerType: T): ZodPromise<T>;
interface ZodFunction<Args extends $ZodFunctionIn = $ZodFunctionIn, Returns extends $ZodFunctionOut = $ZodFunctionOut> extends _ZodType<$ZodFunctionInternals<Args, Returns>>, $ZodFunction<Args, Returns> {
  "~standard": ZodStandardSchemaWithJSON<this>;
  _def: $ZodFunctionDef<Args, Returns>;
  _input: $InferInnerFunctionType<Args, Returns>;
  _output: $InferOuterFunctionType<Args, Returns>;
  input<const Items extends TupleItems, const Rest extends $ZodFunctionOut = $ZodFunctionOut>(args: Items, rest?: Rest): ZodFunction<$ZodTuple<Items, Rest>, Returns>;
  input<NewArgs extends $ZodFunctionIn>(args: NewArgs): ZodFunction<NewArgs, Returns>;
  input(...args: any[]): ZodFunction<any, Returns>;
  output<NewReturns extends $ZodType>(output: NewReturns): ZodFunction<Args, NewReturns>;
}
declare const ZodFunction: $constructor<ZodFunction>;
declare function _function(): ZodFunction;
declare function _function<const In extends ReadonlyArray<$ZodType>>(params: {
  input: In;
}): ZodFunction<ZodTuple<In, null>, $ZodFunctionOut>;
declare function _function<const In extends ReadonlyArray<$ZodType>, const Out extends $ZodFunctionOut = $ZodFunctionOut>(params: {
  input: In;
  output: Out;
}): ZodFunction<ZodTuple<In, null>, Out>;
declare function _function<const In extends $ZodFunctionIn = $ZodFunctionIn>(params: {
  input: In;
}): ZodFunction<In, $ZodFunctionOut>;
declare function _function<const Out extends $ZodFunctionOut = $ZodFunctionOut>(params: {
  output: Out;
}): ZodFunction<$ZodFunctionIn, Out>;
declare function _function<In extends $ZodFunctionIn = $ZodFunctionIn, Out extends $ZodType = $ZodType>(params?: {
  input: In;
  output: Out;
}): ZodFunction<In, Out>;
interface ZodCustom<O = unknown, I = unknown> extends _ZodType<$ZodCustomInternals<O, I>>, $ZodCustom<O, I> {
  "~standard": ZodStandardSchemaWithJSON<this>;
}
declare const ZodCustom: $constructor<ZodCustom>;
declare function check<O = unknown>(fn: CheckFn<O>): $ZodCheck<O>;
declare function custom<O>(fn?: (data: unknown) => unknown, _params?: string | $ZodCustomParams | undefined): ZodCustom<O, O>;
declare function refine<T>(fn: (arg: NoInfer<T>) => MaybeAsync<unknown>, _params?: string | $ZodCustomParams): $ZodCheck<T>;
declare function superRefine<T>(fn: (arg: T, payload: $RefinementCtx<T>) => void | Promise<void>, params?: $ZodSuperRefineParams): $ZodCheck<T>;
declare const describe: typeof describe$1;
declare const meta: typeof meta$1;
type ZodInstanceOfParams = Params<ZodCustom, $ZodIssueCustom, "type" | "check" | "checks" | "fn" | "abort" | "error" | "params" | "path">;
declare function _instanceof<T extends typeof Class>(cls: T, params?: ZodInstanceOfParams): ZodCustom<InstanceType<T>, InstanceType<T>>;
declare const stringbool: (_params?: string | $ZodStringBoolParams) => ZodCodec<ZodString, ZodBoolean>;
type _ZodJSONSchema = ZodUnion<[ZodString, ZodNumber, ZodBoolean, ZodNull, ZodArray<ZodJSONSchema>, ZodRecord<ZodString, ZodJSONSchema>]>;
type _ZodJSONSchemaInternals = _ZodJSONSchema["_zod"];
interface ZodJSONSchemaInternals extends _ZodJSONSchemaInternals {
  output: JSONType;
  input: JSONType;
}
interface ZodJSONSchema extends _ZodJSONSchema {
  _zod: ZodJSONSchemaInternals;
}
declare function json(params?: string | $ZodCustomParams): ZodJSONSchema;
declare function preprocess<A, U extends SomeType, B = unknown>(fn: (arg: B, ctx: $RefinementCtx) => A, schema: U): ZodPreprocess<U>;
//#endregion
export { ZodPipe as $, $ZodTypes as $i, stringbool as $n, _includes as $r, describe as $t, ZodIPv4 as A, config as Ai, meta as An, safeEncodeAsync as Ar, _ZodType as At, ZodLiteral as B, treeifyError as Bi, optional as Bn, $ZodBigIntParams as Br, array as Bt, ZodEnum as C, _trim as Ci, ksuid as Cn, encode as Cr, ZodXID as Ct, ZodFloat64 as D, $brand as Di, looseRecord as Dn, safeDecode as Dr, _ZodDate as Dt, ZodFloat32 as E, regexes_d_exports as Ei, looseObject as En, parseAsync as Er, _ZodBoolean as Et, ZodJSONSchema as F, $ZodFormattedError as Fi, nonoptional as Fn, ZodIssue as Fr, _instanceof as Ft, ZodNever as G, $ZodISODateTimeInternals as Gi, promise as Gn, $ZodISODurationParams as Gr, check as Gt, ZodMap as H, $ZodBooleanInternals as Hi, pipe as Hn, $ZodDateParams as Hr, base64url as Ht, ZodJSONSchemaInternals as I, $ZodIssue as Ii, nullable as In, ZodRealError as Ir, _null as It, ZodNullable as J, $ZodNumberInternals as Ji, refine as Jn, $ZodStringParams as Jr, codec as Jt, ZodNonOptional as K, $ZodISODurationInternals as Ki, readonly as Kn, $ZodISOTimeParams as Kr, cidrv4 as Kt, ZodJWT as L, flattenError as Li, nullish as Ln, index_d_exports as Lr, _undefined as Lt, ZodInt as M, output as Mi, nanoid as Mn, safeParseAsync as Mr, _default as Mt, ZodInt32 as N, $ZodErrorMap as Ni, nativeEnum as Nn, IssueData as Nr, _enum as Nt, ZodFunction as O, $constructor as Oi, mac as On, safeDecodeAsync as Or, _ZodNumber as Ot, ZodIntersection as P, $ZodFlattenedError as Pi, never as Pn, ZodError as Pr, _function as Pt, ZodOptional as Q, $ZodTypeInternals as Qi, stringFormat as Qn, _gte as Qr, date as Qt, ZodKSUID as R, formatError as Ri, number as Rn, toJSONSchema as Rr, _void as Rt, ZodEmoji as S, _toUpperCase as Si, keyof as Sn, decodeAsync as Sr, ZodVoid as St, ZodFile as T, index_d_exports$1 as Ti, literal as Tn, parse as Tr, _ZodBigInt as Tt, ZodNaN as U, $ZodDateInternals as Ui, prefault as Un, $ZodISODateParams as Ur, bigint as Ut, ZodMAC as V, $ZodBigIntInternals as Vi, partialRecord as Vn, $ZodBooleanParams as Vr, base64 as Vt, ZodNanoID as W, $ZodISODateInternals as Wi, preprocess as Wn, $ZodISODateTimeParams as Wr, boolean as Wt, ZodNumberFormat as X, $ZodStringInternals as Xi, strictObject as Xn, _endsWith as Xr, cuid2 as Xt, ZodNumber as Y, $ZodShape as Yi, set as Yn, TimePrecision as Yr, cuid as Yt, ZodObject as Z, $ZodType as Zi, string as Zn, _gt as Zr, custom as Zt, ZodDate as _, _regex as _i, invertCodec as _n, xor as _r, ZodURL as _t, ZodBase64URL as a, clone as aa, _maxSize as ai, file as an, tuple as ar, ZodSet as at, ZodE164 as b, _startsWith as bi, json as bn, ZodSafeParseSuccess as br, ZodUnion as bt, ZodBoolean as c, $input as ca, _minSize as ci, guid as cn, ulid as cr, ZodStringFormat as ct, ZodCUID as d, globalRegistry as da, _nonnegative as di, hostname as dn, url as dr, ZodTemplateLiteral as dt, $catchall as ea, _length as ei, discriminatedUnion as en, success as er, ZodPrefault as et, ZodCUID2 as f, registry as fa, _nonpositive as fi, httpUrl as fn, uuid as fr, ZodTransform as ft, ZodCustomStringFormat as g, _property as gi, intersection as gn, xid as gr, ZodULID as gt, ZodCustom as h, _positive as hi, int64 as hn, uuidv7 as hr, ZodUInt32 as ht, ZodBase64 as i, JSONType as ia, _maxLength as ii, exactOptional as in, transform as ir, ZodRecord as it, ZodIPv6 as j, input as ji, nan as jn, safeParse as jr, _catch as jt, ZodGUID as k, NEVER as ki, map as kn, safeEncode as kr, _ZodString as kt, ZodCIDRv4 as l, $output as la, _multipleOf as li, hash as ln, union as lr, ZodSuccess as lt, ZodCodec as m, _overwrite as mi, int32 as mn, uuidv6 as mr, ZodType as mt, ZodAny as n, $strict as na, _lt as ni, email as nn, symbol as nr, ZodPromise as nt, ZodBigInt as o, util_d_exports as oa, _mime as oi, float32 as on, uint32 as or, ZodStandardSchemaWithJSON as ot, ZodCatch as p, JSONSchema as pa, _normalize as pi, int as pn, uuidv4 as pr, ZodTuple as pt, ZodNull as q, $ZodISOTimeInternals as qi, record as qn, $ZodNumberParams as qr, cidrv6 as qt, ZodArray as r, $strip as ra, _lte as ri, emoji as rn, templateLiteral as rr, ZodReadonly as rt, ZodBigIntFormat as s, $ZodRegistry as sa, _minLength as si, float64 as sn, uint64 as sr, ZodString as st, SafeExtendShape as t, $loose as ta, _lowercase as ti, e164 as tn, superRefine as tr, ZodPreprocess as tt, ZodCIDRv6 as u, GlobalMeta as ua, _negative as ui, hex as un, unknown as ur, ZodSymbol as ut, ZodDefault as v, _size as vi, ipv4 as vn, ZodSafeParseError as vr, ZodUUID as vt, ZodExactOptional as w, _uppercase as wi, lazy as wn, encodeAsync as wr, ZodXor as wt, ZodEmail as x, _toLowerCase as xi, jwt as xn, decode as xr, ZodUnknown as xt, ZodDiscriminatedUnion as y, _slugify as yi, ipv6 as yn, ZodSafeParseResult as yr, ZodUndefined as yt, ZodLazy as z, prettifyError as zi, object as zn, $RefinementCtx as zr, any as zt };