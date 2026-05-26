import { y as resolveStateDir } from "../../paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "../../errors-b3ZrCRlt.js";
import "../../fs-safe-CV86zY9G.js";
import { t as appendRegularFile } from "../../regular-file-DaVeNX32.js";
import { t as createSubsystemLogger } from "../../subsystem-DSPWLoK5.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region src/hooks/bundled/command-logger/handler.ts
/**
* Example hook handler: Log all commands to a file
*
* This handler demonstrates how to create a hook that logs all command events
* to a centralized log file for audit/debugging purposes.
*
* To enable this handler, add it to your config:
*
* ```json
* {
*   "hooks": {
*     "internal": {
*       "enabled": true,
*       "handlers": [
*         {
*           "event": "command",
*           "module": "./hooks/handlers/command-logger.ts"
*         }
*       ]
*     }
*   }
* }
* ```
*/
const log = createSubsystemLogger("command-logger");
/**
* Log all command events to a file
*/
const logCommand = async (event) => {
	if (event.type !== "command") return;
	try {
		const stateDir = resolveStateDir(process.env, os.homedir);
		const logDir = path.join(stateDir, "logs");
		await fs.mkdir(logDir, { recursive: true });
		await appendRegularFile({
			filePath: path.join(logDir, "commands.log"),
			content: JSON.stringify({
				timestamp: event.timestamp.toISOString(),
				action: event.action,
				sessionKey: event.sessionKey,
				senderId: event.context.senderId ?? "unknown",
				source: event.context.commandSource ?? "unknown"
			}) + "\n",
			rejectSymlinkParents: true
		});
	} catch (err) {
		const message = formatErrorMessage(err);
		log.error(`Failed to log command: ${message}`);
	}
};
//#endregion
export { logCommand as default };
