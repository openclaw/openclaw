import { spawn } from "node:child_process";
import process from "node:process";
import { PassThrough } from "node:stream";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { killProcessTree } from "../process/kill-tree.js";
import { prepareOomScoreAdjustedSpawn } from "../process/linux-oom-score.js";
const CLOSE_TIMEOUT_MS = 2000;
function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });
}
export class OpenClawStdioClientTransport {
    serverParams;
    onclose;
    onerror;
    onmessage;
    readBuffer = new ReadBuffer();
    stderrStream = null;
    process;
    constructor(serverParams) {
        this.serverParams = serverParams;
        if (serverParams.stderr === "pipe" || serverParams.stderr === "overlapped") {
            this.stderrStream = new PassThrough();
        }
    }
    async start() {
        if (this.process) {
            throw new Error("OpenClawStdioClientTransport already started; Client.connect() starts transports automatically.");
        }
        await new Promise((resolve, reject) => {
            const baseEnv = {
                ...getDefaultEnvironment(),
                ...this.serverParams.env,
            };
            const preparedSpawn = prepareOomScoreAdjustedSpawn(this.serverParams.command, this.serverParams.args ?? [], { env: baseEnv });
            const child = spawn(preparedSpawn.command, preparedSpawn.args, {
                cwd: this.serverParams.cwd,
                detached: process.platform !== "win32",
                env: preparedSpawn.env,
                shell: false,
                stdio: ["pipe", "pipe", this.serverParams.stderr ?? "inherit"],
                windowsHide: process.platform === "win32",
            });
            this.process = child;
            child.on("error", (error) => {
                reject(error);
                this.onerror?.(error);
            });
            child.on("spawn", () => resolve());
            child.on("close", () => {
                this.process = undefined;
                this.onclose?.();
            });
            child.stdin?.on("error", (error) => this.onerror?.(error));
            child.stdout?.on("data", (chunk) => {
                this.readBuffer.append(chunk);
                this.processReadBuffer();
            });
            child.stdout?.on("error", (error) => this.onerror?.(error));
            if (this.stderrStream && child.stderr) {
                child.stderr.pipe(this.stderrStream);
            }
        });
    }
    get stderr() {
        return this.stderrStream ?? this.process?.stderr ?? null;
    }
    get pid() {
        return this.process?.pid ?? null;
    }
    processReadBuffer() {
        while (true) {
            try {
                const message = this.readBuffer.readMessage();
                if (message === null) {
                    break;
                }
                this.onmessage?.(message);
            }
            catch (error) {
                this.onerror?.(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
    async close() {
        const processToClose = this.process;
        this.process = undefined;
        if (processToClose) {
            const closePromise = new Promise((resolve) => {
                processToClose.once("close", () => resolve());
            });
            try {
                processToClose.stdin?.end();
            }
            catch {
                // best-effort
            }
            await Promise.race([closePromise, delay(CLOSE_TIMEOUT_MS)]);
            if (processToClose.exitCode === null && processToClose.pid) {
                killProcessTree(processToClose.pid);
                await Promise.race([closePromise, delay(CLOSE_TIMEOUT_MS)]);
            }
        }
        this.readBuffer.clear();
    }
    send(message) {
        return new Promise((resolve) => {
            const stdin = this.process?.stdin;
            if (!stdin) {
                throw new Error("Not connected");
            }
            const json = serializeMessage(message);
            if (stdin.write(json)) {
                resolve();
            }
            else {
                stdin.once("drain", resolve);
            }
        });
    }
}
