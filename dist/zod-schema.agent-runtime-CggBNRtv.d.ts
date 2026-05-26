import { Q as ZodOptional, Z as ZodObject, na as $strict, r as ZodArray, st as ZodString } from "./schemas-CkRCGSfd.js";

//#region src/config/zod-schema.agent-runtime.d.ts
declare const ToolPolicySchema: ZodOptional<ZodObject<{
  allow: ZodOptional<ZodArray<ZodString>>;
  alsoAllow: ZodOptional<ZodArray<ZodString>>;
  deny: ZodOptional<ZodArray<ZodString>>;
}, $strict>>;
//#endregion
export { ToolPolicySchema as t };