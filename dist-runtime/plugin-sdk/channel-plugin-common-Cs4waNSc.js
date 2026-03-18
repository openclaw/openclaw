import { s as init_session_key } from "./session-key-BwICpQs5.js";
import { G as init_registry } from "./runtime-CDMAx_h4.js";
//#region src/channels/plugins/pairing-message.ts
const PAIRING_APPROVED_MESSAGE = "✅ OpenClaw access approved. Send a message to start chatting.";
//#endregion
//#region src/plugin-sdk/channel-plugin-common.ts
init_session_key();
init_registry();
//#endregion
export { PAIRING_APPROVED_MESSAGE as t };
