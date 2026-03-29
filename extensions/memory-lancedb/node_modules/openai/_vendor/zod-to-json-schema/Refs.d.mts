import type { ZodTypeDef } from 'zod/v3';
import { Options, Targets } from "./Options.mjs";
import { JsonSchema7Type } from "./parseDef.mjs";
export type Refs = {
    seen: Map<ZodTypeDef, Seen>;
    /**
     * Set of all the `$ref`s we created, e.g. `Set(['#/$defs/ui'])`
     * this notable does not include any `definitions` that were
     * explicitly given as an option.
     */
    seenRefs: Set<string>;
    currentPath: string[];
    propertyPath: string[] | undefined;
} & Options<Targets>;
export type Seen = {
    def: ZodTypeDef;
    path: string[];
    jsonSchema: JsonSchema7Type | undefined;
};
export declare const getRefs: (options?: string | Partial<Options<Targets>>) => Refs;
//# sourceMappingURL=Refs.d.mts.map