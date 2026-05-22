//#region extensions/gradium/shared.d.ts
declare const DEFAULT_GRADIUM_VOICE_ID = "YTpq7expH9539ERJ";
declare const GRADIUM_VOICES: readonly [{
  readonly id: "YTpq7expH9539ERJ";
  readonly name: "Emma";
}, {
  readonly id: "LFZvm12tW_z0xfGo";
  readonly name: "Kent";
}, {
  readonly id: "Eu9iL_CYe8N-Gkx_";
  readonly name: "Tiffany";
}, {
  readonly id: "2H4HY2CBNyJHBCrP";
  readonly name: "Christina";
}, {
  readonly id: "jtEKaLYNn6iif5PR";
  readonly name: "Sydney";
}, {
  readonly id: "KWJiFWu2O9nMPYcR";
  readonly name: "John";
}, {
  readonly id: "3jUdJyOi9pgbxBTK";
  readonly name: "Arthur";
}];
declare function normalizeGradiumBaseUrl(baseUrl?: string): string;
//#endregion
export { DEFAULT_GRADIUM_VOICE_ID, GRADIUM_VOICES, normalizeGradiumBaseUrl };