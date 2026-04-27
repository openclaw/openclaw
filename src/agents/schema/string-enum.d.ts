import { Type } from "typebox";
type StringEnumOptions<T extends readonly string[]> = {
    description?: string;
    title?: string;
    default?: T[number];
};
export declare function stringEnum<T extends readonly string[]>(values: T, options?: StringEnumOptions<T>): Type.TUnsafe<T[number]>;
export declare function optionalStringEnum<T extends readonly string[]>(values: T, options?: StringEnumOptions<T>): Type.TOptional<Type.TUnsafe<T[number]>>;
export {};
