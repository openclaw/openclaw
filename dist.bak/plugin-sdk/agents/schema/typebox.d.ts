type StringEnumOptions<T extends readonly string[]> = {
    description?: string;
    title?: string;
    default?: T[number];
};
export declare function stringEnum<T extends readonly string[]>(values: T, options?: StringEnumOptions<T>): import("@sinclair/typebox").TUnsafe<T[number]>;
export declare function optionalStringEnum<T extends readonly string[]>(values: T, options?: StringEnumOptions<T>): import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<T[number]>>;
export declare function channelTargetSchema(options?: {
    description?: string;
}): import("@sinclair/typebox").TString;
export declare function channelTargetsSchema(options?: {
    description?: string;
}): import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
export {};
