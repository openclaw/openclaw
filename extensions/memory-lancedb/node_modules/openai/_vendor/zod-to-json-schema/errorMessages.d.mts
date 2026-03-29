import { JsonSchema7TypeUnion } from "./parseDef.mjs";
import { Refs } from "./Refs.mjs";
export type ErrorMessages<T extends JsonSchema7TypeUnion, OmitProperties extends string = ''> = Partial<Omit<{
    [key in keyof T]: string;
}, OmitProperties | 'type' | 'errorMessages'>>;
export declare function addErrorMessage<T extends {
    errorMessage?: ErrorMessages<any>;
}>(res: T, key: keyof T, errorMessage: string | undefined, refs: Refs): void;
export declare function setResponseValueAndErrors<Json7Type extends JsonSchema7TypeUnion & {
    errorMessage?: ErrorMessages<Json7Type>;
}, Key extends keyof Omit<Json7Type, 'errorMessage'>>(res: Json7Type, key: Key, value: Json7Type[Key], errorMessage: string | undefined, refs: Refs): void;
//# sourceMappingURL=errorMessages.d.mts.map