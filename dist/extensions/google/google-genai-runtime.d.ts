import { GoogleGenAI } from "@google/genai";

//#region extensions/google/google-genai-runtime.d.ts
type GoogleGenAIClient = InstanceType<typeof GoogleGenAI>;
type GoogleGenAIOptions = ConstructorParameters<typeof GoogleGenAI>[0];
declare function createGoogleGenAI(options: GoogleGenAIOptions): GoogleGenAIClient;
//#endregion
export { GoogleGenAIClient, createGoogleGenAI };