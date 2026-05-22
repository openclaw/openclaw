import { _ as sleep } from "../../utils-927g1oFZ.js";
import { A as TtsAutoSchema, M as TtsModeSchema, N as TtsProviderSchema, j as TtsConfigSchema } from "../../zod-schema.core-ZZiuAHri.js";
import { c as isBlockedHostnameOrIp } from "../../ssrf-jPQ1XkmH.js";
import { n as fetchWithSsrFGuard } from "../../fetch-guard-DGYfmBq6.js";
import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import { a as isRequestBodyLimitError, c as requestBodyErrorToText, s as readRequestBodyWithLimit } from "../../http-body-DOTV5Xjj.js";
import "../../runtime-api-DA4p1cYp.js";
export { TtsAutoSchema, TtsConfigSchema, TtsModeSchema, TtsProviderSchema, definePluginEntry, fetchWithSsrFGuard, isBlockedHostnameOrIp, isRequestBodyLimitError, readRequestBodyWithLimit, requestBodyErrorToText, sleep };
