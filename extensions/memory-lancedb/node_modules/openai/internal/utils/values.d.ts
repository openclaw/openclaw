export declare const isAbsoluteURL: (url: string) => boolean;
export declare let isArray: (val: unknown) => val is unknown[];
export declare let isReadonlyArray: (val: unknown) => val is readonly unknown[];
/** Returns an object if the given value isn't an object, otherwise returns as-is */
export declare function maybeObj(x: unknown): object;
export declare function isEmptyObj(obj: Object | null | undefined): boolean;
export declare function hasOwn<T extends object = object>(obj: T, key: PropertyKey): key is keyof T;
export declare function isObj(obj: unknown): obj is Record<string, unknown>;
export declare const ensurePresent: <T>(value: T | null | undefined) => T;
export declare const validatePositiveInteger: (name: string, n: unknown) => number;
export declare const coerceInteger: (value: unknown) => number;
export declare const coerceFloat: (value: unknown) => number;
export declare const coerceBoolean: (value: unknown) => boolean;
export declare const maybeCoerceInteger: (value: unknown) => number | undefined;
export declare const maybeCoerceFloat: (value: unknown) => number | undefined;
export declare const maybeCoerceBoolean: (value: unknown) => boolean | undefined;
export declare const safeJSON: (text: string) => any;
//# sourceMappingURL=values.d.ts.map