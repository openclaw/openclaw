import { t as tryDispatchAcpReplyHook } from "../../acp-runtime-backend-Cu19Q9r6.js";
import { t as createAcpxRuntimeService } from "./register.runtime-Be8eeJjz.js";
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
