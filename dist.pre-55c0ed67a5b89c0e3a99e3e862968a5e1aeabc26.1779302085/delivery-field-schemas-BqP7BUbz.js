import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { An as preprocess, Rn as string, Xn as union, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
//#region src/cron/delivery-field-schemas.ts
const trimStringPreprocess = (value) => typeof value === "string" ? value.trim() : value;
const trimLowercaseStringPreprocess = (value) => normalizeOptionalLowercaseString(value) ?? value;
const DeliveryModeFieldSchema = preprocess(trimLowercaseStringPreprocess, _enum([
	"deliver",
	"announce",
	"none",
	"webhook"
])).transform((value) => value === "deliver" ? "announce" : value);
const LowercaseNonEmptyStringFieldSchema = preprocess(trimLowercaseStringPreprocess, string().min(1));
const TrimmedNonEmptyStringFieldSchema = preprocess(trimStringPreprocess, string().min(1));
const DeliveryThreadIdFieldSchema = union([TrimmedNonEmptyStringFieldSchema, number().finite()]);
const TimeoutSecondsFieldSchema = number().finite().transform((value) => Math.max(0, value));
function parseDeliveryInput(input) {
	return {
		mode: parseOptionalField(DeliveryModeFieldSchema, input.mode),
		channel: parseOptionalField(LowercaseNonEmptyStringFieldSchema, input.channel),
		to: parseOptionalField(TrimmedNonEmptyStringFieldSchema, input.to),
		threadId: parseOptionalField(DeliveryThreadIdFieldSchema, input.threadId),
		accountId: parseOptionalField(TrimmedNonEmptyStringFieldSchema, input.accountId)
	};
}
function parseOptionalField(schema, value) {
	const parsed = schema.safeParse(value);
	return parsed.success ? parsed.data : void 0;
}
//#endregion
export { parseDeliveryInput as a, TrimmedNonEmptyStringFieldSchema as i, LowercaseNonEmptyStringFieldSchema as n, parseOptionalField as o, TimeoutSecondsFieldSchema as r, DeliveryThreadIdFieldSchema as t };
