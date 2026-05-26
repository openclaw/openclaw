import "./zod-schema.core-CrlgnnCI.js";
import { t as createLazyFacadeObjectValue } from "./facade-loader-BqRX3EBI.js";
import { n as loadActivatedBundledPluginPublicSurfaceModuleSync, t as createLazyFacadeValue } from "./facade-runtime-BJdBwhen.js";
//#region src/plugin-sdk/tts-runtime.ts
function loadFacadeModule() {
	return loadActivatedBundledPluginPublicSurfaceModuleSync({
		dirName: "speech-core",
		artifactBasename: "runtime-api.js"
	});
}
function prewarmTtsRuntimeFacade() {
	loadFacadeModule();
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
const streamSpeech = createLazyFacadeValue(loadFacadeModule, "streamSpeech");
const textToSpeech = createLazyFacadeValue(loadFacadeModule, "textToSpeech");
const textToSpeechStream = createLazyFacadeValue(loadFacadeModule, "textToSpeechStream");
const textToSpeechTelephony = createLazyFacadeValue(loadFacadeModule, "textToSpeechTelephony");
//#endregion
export { textToSpeechStream as A, setTtsEnabled as C, streamSpeech as D, setTtsProvider as E, synthesizeSpeech as O, setTtsAutoMode as S, setTtsPersona as T, resolveTtsConfig as _, getTtsMaxLength as a, setLastTtsAttempt as b, isSummarizationEnabled as c, listSpeechVoices as d, listTtsPersonas as f, resolveTtsAutoMode as g, resolveExplicitTtsOverrides as h, getResolvedSpeechProviderConfig as i, textToSpeechTelephony as j, textToSpeech as k, isTtsEnabled as l, prewarmTtsRuntimeFacade as m, buildTtsSystemPromptHint as n, getTtsPersona as o, maybeApplyTtsToPayload as p, getLastTtsAttempt as r, getTtsProvider as s, _test as t, isTtsProviderConfigured as u, resolveTtsPrefsPath as v, setTtsMaxLength as w, setSummarizationEnabled as x, resolveTtsProviderOrder as y };
