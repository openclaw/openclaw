import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../control-service.js";
import { describeBrowserControlUnavailable } from "../plugin-enabled.js";
import {
  createBrowserRouteDispatcher,
  type BrowserDispatchRequest,
  type BrowserDispatchResponse,
} from "./routes/dispatcher.js";

export async function dispatchBrowserControlRequest(
  req: BrowserDispatchRequest,
): Promise<BrowserDispatchResponse> {
  const started = await startBrowserControlServiceFromConfig();
  if (!started) {
    return { status: 503, body: { error: await describeBrowserControlUnavailable() } };
  }
  const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
  await req.assertCurrent?.();
  return await dispatcher.dispatch(req);
}
