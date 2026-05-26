export { escapeRegExp } from "../../utils.js";
type EnvelopeTimestampZone = string;
export declare function formatEnvelopeTimestamp(date: Date, zone?: EnvelopeTimestampZone): string;
export declare function formatLocalEnvelopeTimestamp(date: Date): string;
