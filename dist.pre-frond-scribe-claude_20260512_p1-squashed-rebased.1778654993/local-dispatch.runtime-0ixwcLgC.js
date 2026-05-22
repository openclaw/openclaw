import { r as createBrowserRouteDispatcher, t as startBrowserControlServiceFromConfig } from "./control-service-Cz1SmdoU.js";
import { n as createBrowserControlContext } from "./plugin-enabled-CfuYDd4s.js";
//#region extensions/browser/src/browser/local-dispatch.runtime.ts
async function dispatchBrowserControlRequest(req) {
	if (!await startBrowserControlServiceFromConfig()) throw new Error("browser control disabled");
	return await createBrowserRouteDispatcher(createBrowserControlContext()).dispatch(req);
}
//#endregion
export { dispatchBrowserControlRequest };
