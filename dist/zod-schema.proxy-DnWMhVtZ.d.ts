import { C as ZodEnum, Mi as output, Q as ZodOptional, Z as ZodObject, _t as ZodURL, c as ZodBoolean, na as $strict, st as ZodString } from "./schemas-CkRCGSfd.js";

//#region src/config/zod-schema.proxy.d.ts
declare const ProxyConfigSchema: ZodOptional<ZodObject<{
  enabled: ZodOptional<ZodBoolean>;
  proxyUrl: ZodOptional<ZodURL>;
  tls: ZodOptional<ZodObject<{
    caFile: ZodOptional<ZodString>;
  }, $strict>>;
  loopbackMode: ZodOptional<ZodEnum<{
    proxy: "proxy";
    block: "block";
    "gateway-only": "gateway-only";
  }>>;
}, $strict>>;
type ProxyConfig = output<typeof ProxyConfigSchema>;
//#endregion
export { ProxyConfig as t };