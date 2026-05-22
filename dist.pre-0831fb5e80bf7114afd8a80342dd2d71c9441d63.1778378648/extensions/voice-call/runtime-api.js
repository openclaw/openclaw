import { _ as sleep } from "../../utils-927g1oFZ.js";
import { A as TtsAutoSchema, M as TtsModeSchema, N as TtsProviderSchema, j as TtsConfigSchema } from "../../zod-schema.core-ZZiuAHri.js";
import { c as isBlockedHostnameOrIp } from "../../ssrf-Du39boJ_.js";
import { n as fetchWithSsrFGuard } from "../../fetch-guard-SM3_DGaZ.js";
import { t as definePluginEntry } from "../../plugin-entry-CdPayZCH.js";
import { a as isRequestBodyLimitError, c as requestBodyErrorToText, s as readRequestBodyWithLimit } from "../../http-body-B8VSBCXN.js";
import "../../runtime-api-IvgKYK47.js";
export { TtsAutoSchema, TtsConfigSchema, TtsModeSchema, TtsProviderSchema, definePluginEntry, fetchWithSsrFGuard, isBlockedHostnameOrIp, isRequestBodyLimitError, readRequestBodyWithLimit, requestBodyErrorToText, sleep };
