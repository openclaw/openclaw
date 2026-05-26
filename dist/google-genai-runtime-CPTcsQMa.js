import { GoogleGenAI } from "@google/genai";
//#region extensions/google/google-genai-runtime.ts
function createGoogleGenAI(options) {
	return new GoogleGenAI(options);
}
//#endregion
export { createGoogleGenAI as t };
