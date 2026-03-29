import { ZodNativeEnumDef } from 'zod/v3';
export type JsonSchema7NativeEnumType = {
    type: 'string' | 'number' | ['string', 'number'];
    enum: (string | number)[];
};
export declare function parseNativeEnumDef(def: ZodNativeEnumDef): JsonSchema7NativeEnumType;
//# sourceMappingURL=nativeEnum.d.mts.map