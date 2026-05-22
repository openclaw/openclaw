import "./zod-schema.core-Cm4mTdD7.js";
import { t as createLazyFacadeObjectValue } from "./facade-loader-DANwau6-.js";
import { n as loadActivatedBundledPluginPublicSurfaceModuleSync, t as createLazyFacadeValue } from "./facade-runtime-BfbcZzq7.js";
//#region src/plugin-sdk/tts-runtime.ts
function loadFacadeModule() {
	return loadActivatedBundledPluginPublicSurfaceModuleSync({
		dirName: "speech-core",
		artifactBasename: "runtime-api.js"
	});
}
const _test = createLazyFacadeObjectValue(() => loadFacadeModule()._test);
const buildTtsSystemPromptHint = createLazyFacadeValue(loadFacadeModule, "buildTtsSystemPromptHint");
const getLastTtsAttempt = createLazyFacadeValue(loadFacadeModule, "getLastTtsAttempt");
const getResolvedSpeechProviderConfig = createLazyFacadeValue(loadFacadeModule, "getResolvedSpeechProviderConfig");
const getTtsMaxLength = createLazyFacadeValue(loadFacadeModule, "getTtsMaxLength");
const getTtsPersona = createLazyFacadeValue(loadFacadeModule, "getTtsPersona");
const getTtsProvider = createLazyFacadeValue(loadFacadeModule, "getTtsProvider");
const isSummarizationEnabled = createLazyFacadeValue(loadFacadeModule, "isSummarizationEnabled");
const isTtsEnabled = createLazyFacadeValue(loadFacadeModule, "isTtsEnabled");
const isTtsProviderConfigured = createLazyFacadeValue(loadFacadeModule, "isTtsProviderConfigured");
const listSpeechVoices = createLazyFacadeValue(loadFacadeModule, "listSpeechVoices");
const listTtsPersonas = createLazyFacadeValue(loadFacadeModule, "listTtsPersonas");
const maybeApplyTtsToPayload = createLazyFacadeValue(loadFacadeModule, "maybeApplyTtsToPayload");
const resolveExplicitTtsOverrides = createLazyFacadeValue(loadFacadeModule, "resolveExplicitTtsOverrides");
const resolveTtsAutoMode = createLazyFacadeValue(loadFacadeModule, "resolveTtsAutoMode");
const resolveTtsConfig = createLazyFacadeValue(loadFacadeModule, "resolveTtsConfig");
const resolveTtsPrefsPath = createLazyFacadeValue(loadFacadeModule, "resolveTtsPrefsPath");
const resolveTtsProviderOrder = createLazyFacadeValue(loadFacadeModule, "resolveTtsProviderOrder");
const setLastTtsAttempt = createLazyFacadeValue(loadFacadeModule, "setLastTtsAttempt");
const setSummarizationEnabled = createLazyFacadeValue(loadFacadeModule, "setSummarizationEnabled");
const setTtsAutoMode = createLazyFacadeValue(loadFacadeModule, "setTtsAutoMode");
const setTtsEnabled = createLazyFacadeValue(loadFacadeModule, "setTtsEnabled");
const setTtsMaxLength = createLazyFacadeValue(loadFacadeModule, "setTtsMaxLength");
const setTtsPersona = createLazyFacadeValue(loadFacadeModule, "setTtsPersona");
const setTtsProvider = createLazyFacadeValue(loadFacadeModule, "setTtsProvider");
const synthesizeSpeech = createLazyFacadeValue(loadFacadeModule, "synthesizeSpeech");
const textToSpeech = createLazyFacadeValue(loadFacadeModule, "textToSpeech");
const textToSpeechTelephony = createLazyFacadeValue(loadFacadeModule, "textToSpeechTelephony");
//#endregion
export { setTtsMaxLength as C, textToSpeech as D, synthesizeSpeech as E, textToSpeechTelephony as O, setTtsEnabled as S, setTtsProvider as T, resolveTtsPrefsPath as _, getTtsMaxLength as a, setSummarizationEnabled as b, isSummarizationEnabled as c, listSpeechVoices as d, listTtsPersonas as f, resolveTtsConfig as g, resolveTtsAutoMode as h, getResolvedSpeechProviderConfig as i, isTtsEnabled as l, resolveExplicitTtsOverrides as m, buildTtsSystemPromptHint as n, getTtsPersona as o, maybeApplyTtsToPayload as p, getLastTtsAttempt as r, getTtsProvider as s, _test as t, isTtsProviderConfigured as u, resolveTtsProviderOrder as v, setTtsPersona as w, setTtsAutoMode as x, setLastTtsAttempt as y };
