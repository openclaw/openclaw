import { c as normalizeOptionalString } from "../string-coerce-LndEvhRk.js";
import { t as asFiniteNumber } from "../number-coercion-BmB9yxv6.js";
import { a as createProviderHttpError, c as formatProviderErrorPayload, d as truncateErrorDetail, i as assertOkOrThrowProviderError, l as formatProviderHttpErrorMessage, n as asObject, o as extractProviderErrorDetail, s as extractProviderRequestId, t as asBoolean, u as readResponseTextLimited } from "../provider-http-errors-DACFReNe.js";
import { n as normalizeTtsAutoMode, t as TTS_AUTO_MODES } from "../tts-auto-mode-D0Grccmq.js";
import { a as normalizeSpeechProviderId, i as listSpeechProviders, n as getSpeechProvider, t as canonicalizeSpeechProviderId } from "../provider-registry-DVvppdBZ.js";
import { n as parseTtsDirectives } from "../directives-C0xrTE_f.js";
import { a as scheduleCleanup, i as requireInRange, n as normalizeLanguageCode, r as normalizeSeed, t as normalizeApplyTextNormalization } from "../tts-provider-helpers-D12K6HPf.js";
import { t as createOpenAiCompatibleSpeechProvider } from "../speech-DC8rxyc0.js";
export { TTS_AUTO_MODES, asBoolean, asFiniteNumber, asObject, assertOkOrThrowProviderError, canonicalizeSpeechProviderId, createOpenAiCompatibleSpeechProvider, createProviderHttpError, extractProviderErrorDetail, extractProviderRequestId, formatProviderErrorPayload, formatProviderHttpErrorMessage, getSpeechProvider, listSpeechProviders, normalizeApplyTextNormalization, normalizeLanguageCode, normalizeSeed, normalizeSpeechProviderId, normalizeTtsAutoMode, parseTtsDirectives, readResponseTextLimited, requireInRange, scheduleCleanup, normalizeOptionalString as trimToUndefined, truncateErrorDetail };
