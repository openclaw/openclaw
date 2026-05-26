import { dt as TalkConfig, ut as ResolvedTalkConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/config/talk.d.ts
declare function resolveActiveTalkProviderConfig(talk: TalkConfig | undefined): ResolvedTalkConfig | undefined;
//#endregion
export { resolveActiveTalkProviderConfig as t };