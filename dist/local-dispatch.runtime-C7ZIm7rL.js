import { r as createBrowserRouteDispatcher, t as startBrowserControlServiceFromConfig } from "./control-service-QFP_AmWr.js";
import { n as createBrowserControlContext } from "./plugin-enabled-QdB1nwFY.js";
//#region extensions/browser/src/browser/local-dispatch.runtime.ts
async function dispatchBrowserControlRequest(req) {
	if (!await startBrowserControlServiceFromConfig()) throw new Error("browser control disabled");
	return await createBrowserRouteDispatcher(createBrowserControlContext()).dispatch(req);
}
//#endregion
export { dispatchBrowserControlRequest };
