import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { z } from "zod";
//#region src/cron/delivery-field-schemas.ts
const trimStringPreprocess = (value) => typeof value === "string" ? value.trim() : value;
const trimLowercaseStringPreprocess = (value) => normalizeOptionalLowercaseString(value) ?? value;
const DeliveryModeFieldSchema = z.preprocess(trimLowercaseStringPreprocess, z.enum([
	"deliver",
	"announce",
	"none",
	"webhook"
])).transform((value) => value === "deliver" ? "announce" : value);
const LowercaseNonEmptyStringFieldSchema = z.preprocess(trimLowercaseStringPreprocess, z.string().min(1));
const TrimmedNonEmptyStringFieldSchema = z.preprocess(trimStringPreprocess, z.string().min(1));
const DeliveryThreadIdFieldSchema = z.union([TrimmedNonEmptyStringFieldSchema, z.number().finite()]);
const TimeoutSecondsFieldSchema = z.number().finite().transform((value) => Math.max(0, value));
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
