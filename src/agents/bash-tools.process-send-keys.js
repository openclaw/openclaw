import { deriveSessionName } from "./bash-tools.shared.js";
import { encodeKeySequence, hasCursorModeSensitiveKeys } from "./pty-keys.js";
function failText(text) {
    return {
        content: [
            {
                type: "text",
                text,
            },
        ],
        details: { status: "failed" },
    };
}
async function writeToStdin(stdin, data) {
    await new Promise((resolve, reject) => {
        stdin.write(data, (err) => {
            if (err) {
                reject(err);
            }
            else {
                resolve();
            }
        });
    });
}
export async function handleProcessSendKeys(params) {
    const request = {
        keys: params.keys,
        hex: params.hex,
        literal: params.literal,
    };
    if (params.session.cursorKeyMode === "unknown" && hasCursorModeSensitiveKeys(request)) {
        return failText(`Session ${params.sessionId} cursor key mode is not known yet. Poll or log until startup output appears, then retry send-keys.`);
    }
    const cursorKeyMode = params.session.cursorKeyMode === "unknown" ? undefined : params.session.cursorKeyMode;
    const { data, warnings } = encodeKeySequence(request, cursorKeyMode);
    if (!data) {
        return failText("No key data provided.");
    }
    await writeToStdin(params.stdin, data);
    return {
        content: [
            {
                type: "text",
                text: `Sent ${data.length} bytes to session ${params.sessionId}.` +
                    (warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""),
            },
        ],
        details: {
            status: "running",
            sessionId: params.sessionId,
            name: deriveSessionName(params.session.command),
        },
    };
}
