import { t as definePluginEntry } from "../../plugin-entry-DtJdmmKN.js";
import { t as FILE_TRANSFER_NODE_INVOKE_COMMANDS } from "../../node-invoke-policy-commands-Pb879KyS.js";
import { a as DIR_LIST_TOOL_DESCRIPTOR, c as FILE_FETCH_TOOL_DESCRIPTOR, d as FILE_WRITE_TOOL_DESCRIPTOR, r as DIR_FETCH_TOOL_DESCRIPTOR } from "../../descriptors-BoMy28TL.js";
//#region extensions/file-transfer/src/shared/lazy-node-invoke-policy.ts
const loadFileTransferNodeInvokePolicy = async () => {
	const { createFileTransferNodeInvokePolicy } = await import("../../node-invoke-policy-BKq6pL5d.js");
	return createFileTransferNodeInvokePolicy();
};
function createLazyFileTransferNodeInvokePolicy(loadPolicy = loadFileTransferNodeInvokePolicy) {
	let policyPromise;
	return {
		commands: [...FILE_TRANSFER_NODE_INVOKE_COMMANDS],
		async handle(ctx) {
			let policy;
			try {
				policyPromise ??= loadPolicy();
				policy = await policyPromise;
			} catch (error) {
				return {
					ok: false,
					code: "PLUGIN_POLICY_UNAVAILABLE",
					message: `file-transfer PLUGIN_POLICY_UNAVAILABLE: node.invoke policy unavailable: ${error instanceof Error && error.message ? error.message : String(error)}`,
					unavailable: true
				};
			}
			return await policy.handle(ctx);
		}
	};
}
//#endregion
//#region extensions/file-transfer/index.ts
function readNodeCommandParams(paramsJSON) {
	return paramsJSON ? JSON.parse(paramsJSON) : {};
}
function createLazyTool(descriptor, loadTool) {
	let toolPromise;
	const loadOnce = () => {
		toolPromise ??= loadTool();
		return toolPromise;
	};
	return {
		...descriptor,
		async execute(toolCallId, args, signal, onUpdate) {
			return await (await loadOnce()).execute(toolCallId, args, signal, onUpdate);
		}
	};
}
var file_transfer_default = definePluginEntry({
	id: "file-transfer",
	name: "File Transfer",
	description: "Fetch, list, and write files on paired nodes via dedicated node commands.",
	nodeHostCommands: [
		{
			command: "file.fetch",
			cap: "file",
			dangerous: true,
			handle: async (paramsJSON) => {
				const { handleFileFetch } = await import("../../file-fetch-D69gi5bJ.js");
				const result = await handleFileFetch(readNodeCommandParams(paramsJSON));
				return JSON.stringify(result);
			}
		},
		{
			command: "dir.list",
			cap: "file",
			dangerous: true,
			handle: async (paramsJSON) => {
				const { handleDirList } = await import("../../dir-list-DwmJIJHT.js");
				const result = await handleDirList(readNodeCommandParams(paramsJSON));
				return JSON.stringify(result);
			}
		},
		{
			command: "dir.fetch",
			cap: "file",
			dangerous: true,
			handle: async (paramsJSON) => {
				const { handleDirFetch } = await import("../../dir-fetch-Y6fVyj-3.js");
				const result = await handleDirFetch(readNodeCommandParams(paramsJSON));
				return JSON.stringify(result);
			}
		},
		{
			command: "file.write",
			cap: "file",
			dangerous: true,
			handle: async (paramsJSON) => {
				const { handleFileWrite } = await import("../../file-write-RI4v8IZK.js");
				const result = await handleFileWrite(readNodeCommandParams(paramsJSON));
				return JSON.stringify(result);
			}
		}
	],
	register(api) {
		api.registerNodeInvokePolicy(createLazyFileTransferNodeInvokePolicy());
		api.registerTool(createLazyTool(FILE_FETCH_TOOL_DESCRIPTOR, async () => {
			const { createFileFetchTool } = await import("../../file-fetch-tool-B7e3JONK.js");
			return createFileFetchTool();
		}));
		api.registerTool(createLazyTool(DIR_LIST_TOOL_DESCRIPTOR, async () => {
			const { createDirListTool } = await import("../../dir-list-tool-DOypESEt.js");
			return createDirListTool();
		}));
		api.registerTool(createLazyTool(DIR_FETCH_TOOL_DESCRIPTOR, async () => {
			const { createDirFetchTool } = await import("../../dir-fetch-tool-D57aVDc5.js");
			return createDirFetchTool();
		}));
		api.registerTool(createLazyTool(FILE_WRITE_TOOL_DESCRIPTOR, async () => {
			const { createFileWriteTool } = await import("../../file-write-tool-BDynUctC.js");
			return createFileWriteTool();
		}));
	}
});
//#endregion
export { file_transfer_default as default };
