import { t as tryDispatchAcpReplyHook } from "../../acp-runtime-backend-BlsDtyeQ.js";
import { t as createAcpxRuntimeService } from "../../register.runtime-BdjXZXLg.js";
//#region extensions/acpx/index.ts
const plugin = {
	id: "acpx",
	name: "ACPX Runtime",
	description: "Embedded ACP runtime backend with plugin-owned session and transport management.",
	register(api) {
		api.registerService(createAcpxRuntimeService({ pluginConfig: api.pluginConfig }));
		api.on("reply_dispatch", tryDispatchAcpReplyHook);
	}
};
//#endregion
export { plugin as default };
