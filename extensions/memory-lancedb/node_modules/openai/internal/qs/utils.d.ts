import type { DefaultEncoder, Format } from "./types.js";
export declare let has: (obj: object, key: PropertyKey) => boolean;
export declare function merge(target: any, source: any, options?: {
    plainObjects?: boolean;
    allowPrototypes?: boolean;
}): any;
export declare function assign_single_source(target: any, source: any): any;
export declare function decode(str: string, _: any, charset: string): string;
export declare const encode: (str: any, defaultEncoder: DefaultEncoder, charset: string, type: 'key' | 'value', format: Format) => string;
export declare function compact(value: any): any;
export declare function is_regexp(obj: any): boolean;
export declare function is_buffer(obj: any): boolean;
export declare function combine(a: any, b: any): never[];
export declare function maybe_map<T>(val: T[], fn: (v: T) => T): T | T[];
//# sourceMappingURL=utils.d.ts.map