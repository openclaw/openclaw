// Legacy shim for pre-tsdown update-cli imports.
import * as daemonCli from "../daemon-cli-Do4KJIng.js";
export const registerDaemonCli = daemonCli.t;
export const runDaemonInstall = daemonCli.s;
export const runDaemonRestart = daemonCli.r;
export const runDaemonStart = daemonCli.i;
export const runDaemonStatus = async () => { throw new Error("Legacy daemon CLI export \"runDaemonStatus\" is unavailable in this build. Please upgrade OpenClaw."); };
export const runDaemonStop = daemonCli.a;
export const runDaemonUninstall = daemonCli.o;
