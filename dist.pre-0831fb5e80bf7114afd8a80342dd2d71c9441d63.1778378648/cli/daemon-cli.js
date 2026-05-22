// Legacy shim for pre-tsdown update-cli imports.
import * as daemonCli from "../daemon-cli-V1x-Mcrf.js";
import * as daemonCliRunners0 from "../install.runtime-BVAKVmAv.js";
import * as daemonCliRunners1 from "../lifecycle.runtime-Cn_YQGLj.js";
import * as daemonCliRunners2 from "../status.runtime-MNECb6uS.js";
export const registerDaemonCli = daemonCli.t;
export const runDaemonInstall = daemonCliRunners0.runDaemonInstall;
export const runDaemonRestart = daemonCliRunners1.runDaemonRestart;
export const runDaemonStart = daemonCliRunners1.runDaemonStart;
export const runDaemonStatus = daemonCliRunners2.runDaemonStatus;
export const runDaemonStop = daemonCliRunners1.runDaemonStop;
export const runDaemonUninstall = daemonCliRunners1.runDaemonUninstall;
