/**
 * Lazy Chrome MCP module loader.
 *
 * Keeps the heavy chrome-devtools-mcp adapter behind a runtime import boundary
 * for routes that only need it when existing-session profiles are selected.
 */
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

export const getChromeMcpModule = createLazyRuntimeModule(() => import("./chrome-mcp.js"));
