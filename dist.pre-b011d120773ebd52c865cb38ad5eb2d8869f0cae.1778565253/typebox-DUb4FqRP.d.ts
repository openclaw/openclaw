import { Type } from "typebox";

//#region src/agents/schema/string-enum.d.ts
type StringEnumOptions<T extends readonly string[]> = {
  description?: string;
  title?: string;
  default?: T[number];
  deprecated?: boolean;
};
declare function stringEnum<T extends readonly string[]>(values: T, options?: StringEnumOptions<T>): Type.TUnsafe<T[number]>;
declare function optionalStringEnum<T extends readonly string[]>(values: T, options?: StringEnumOptions<T>): Type.TOptional<Type.TUnsafe<T[number]>>;
//#endregion
//#region src/agents/schema/typebox.d.ts
declare function channelTargetSchema(options?: {
  description?: string;
}): Type.TString;
declare function channelTargetsSchema(options?: {
  description?: string;
}): Type.TArray<Type.TString>;
//#endregion
export { stringEnum as i, channelTargetsSchema as n, optionalStringEnum as r, channelTargetSchema as t };