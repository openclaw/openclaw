//#region src/gateway/server-startup-unavailable-methods.ts
const STARTUP_UNAVAILABLE_GATEWAY_METHODS = [
	"agent.wait",
	"chat.history",
	"models.list",
	"sessions.list",
	"sessions.abort",
	"sessions.create",
	"sessions.send",
	"tools.effective"
];
//#endregion
export { STARTUP_UNAVAILABLE_GATEWAY_METHODS as t };
