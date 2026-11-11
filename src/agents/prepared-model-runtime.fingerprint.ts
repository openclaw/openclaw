import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { sha256Base64Url } from "../infra/crypto-digest.js";

export const fingerprintPreparedRuntimeFacts = (value: unknown): string =>
  sha256Base64Url(stableStringify(value));
