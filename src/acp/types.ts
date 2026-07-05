<<<<<<< HEAD
/** ACP protocol helpers and OpenClaw agent identity metadata. */
=======
/** ACP server option re-exports and OpenClaw agent identity metadata. */
export type { AcpProvenanceMode, AcpServerOptions, AcpSession } from "@openclaw/acp-core/types";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export { normalizeAcpProvenanceMode } from "@openclaw/acp-core/types";
import { VERSION } from "../version.js";

/** ACP agent identity advertised during protocol initialization. */
export const ACP_AGENT_INFO = {
  name: "openclaw-acp",
  title: "OpenClaw ACP Gateway",
  version: VERSION,
};
