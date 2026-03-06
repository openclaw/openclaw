//#region src/infra/node-commands.ts
const NODE_SYSTEM_RUN_COMMANDS = [
	"system.run.prepare",
	"system.run",
	"system.which"
];
const NODE_SYSTEM_NOTIFY_COMMAND = "system.notify";
const NODE_BROWSER_PROXY_COMMAND = "browser.proxy";
const NODE_EXEC_APPROVALS_COMMANDS = ["system.execApprovals.get", "system.execApprovals.set"];

//#endregion
export { NODE_SYSTEM_RUN_COMMANDS as i, NODE_EXEC_APPROVALS_COMMANDS as n, NODE_SYSTEM_NOTIFY_COMMAND as r, NODE_BROWSER_PROXY_COMMAND as t };