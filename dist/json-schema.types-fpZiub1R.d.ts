import { TSchema } from "typebox";

//#region src/shared/json-schema.types.d.ts
type JsonSchemaObject = TSchema & Record<string, unknown>;
//#endregion
export { JsonSchemaObject as t };