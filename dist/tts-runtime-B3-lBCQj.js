import "./zod-schema.core-D7Y_eqdd.js";
import { t as createLazyFacadeObjectValue } from "./facade-loader-Cog8gw3V.js";
import { n as loadActivatedBundledPluginPublicSurfaceModuleSync, t as createLazyFacadeValue } from "./facade-runtime-D0XwEzEs.js";
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
const testApi = createLazyFacadeObjectValue(() => loadFacadeModule().testApi);
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
export { textToSpeechStream as A, setTtsMaxLength as C, synthesizeSpeech as D, streamSpeech as E, testApi as O, setTtsEnabled as S, setTtsProvider as T, resolveTtsPrefsPath as _, getTtsPersona as a, setSummarizationEnabled as b, isTtsEnabled as c, listTtsPersonas as d, maybeApplyTtsToPayload as f, resolveTtsConfig as g, resolveTtsAutoMode as h, getTtsMaxLength as i, textToSpeechTelephony as j, textToSpeech as k, isTtsProviderConfigured as l, resolveExplicitTtsOverrides as m, getLastTtsAttempt as n, getTtsProvider as o, prewarmTtsRuntimeFacade as p, getResolvedSpeechProviderConfig as r, isSummarizationEnabled as s, buildTtsSystemPromptHint as t, listSpeechVoices as u, resolveTtsProviderOrder as v, setTtsPersona as w, setTtsAutoMode as x, setLastTtsAttempt as y };
