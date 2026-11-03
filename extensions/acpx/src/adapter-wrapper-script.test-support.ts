// Executed in a disposable child: mock native events and clocks, not generated lifecycle code.
export const GENERATED_ADAPTER_ORPHAN_SCENARIO = `import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const signals = [];
const child = new EventEmitter();
child.pid = 42;
child.killed = false;
child.stderr = new EventEmitter();
child.kill = (signal) => { signals.push([child.pid, signal]); child.killed = true; };
childProcess.spawn = () => child;
syncBuiltinESMExports();
let parent = 100;
Object.defineProperty(process, "ppid", { get: () => parent });
Object.defineProperty(process, "platform", { value: "linux" });
process.kill = (pid, signal) => { signals.push([pid, signal]); return true; };
process.exit = () => { throw new Error("Generated wrapper forced process exit"); };
process.reallyExit = process.exit;
const names = ["SIGINT", "SIGTERM", "SIGHUP"];
const before = names.map((name) => process.listenerCount(name));
let interval;
let watcherActive = false;
let deadline;
let timerReferenced = true;
let deadlineCancelled = false;
globalThis.setInterval = (callback) => {
  interval = callback;
  watcherActive = true;
  return { unref() {} };
};
globalThis.clearInterval = () => { watcherActive = false; };
globalThis.setTimeout = (callback) => {
  deadline = callback;
  return { unref() { timerReferenced = false; } };
};
globalThis.clearTimeout = () => { deadlineCancelled = true; };
const pollParent = () => { if (watcherActive) interval(); };
await import(pathToFileURL(process.argv[2]).href);
pollParent();
const initialSignals = [...signals];
if (process.argv[3] === "before-orphan") child.emit("exit", 0, null);
// Session-manager reparenting is orphaning too, even when the new parent is not PID 1.
parent = 200;
pollParent();
const orphanSignals = [...signals];
child.killed = true;
if (process.argv[3] === "after-orphan") child.emit("exit", 0, null);
child.emit("close");
const timerStillArmedAfterChildClose = typeof deadline === "function" && !deadlineCancelled;
const listenersRetainedBeforeEscalation = names.every((name, index) =>
  process.listenerCount(name) === before[index] + 1);
const repeatSignalHandled = process.emit("SIGTERM");
if (deadline) deadline();
const exitCode = process.exitCode;
const listenersRetired = names.every((name, index) => process.listenerCount(name) === before[index]);
console.log(JSON.stringify({ initialSignals, orphanSignals, finalSignals: signals,
  timerReferenced, timerStillArmedAfterChildClose, listenersRetainedBeforeEscalation,
  repeatSignalHandled, exitCode, listenersRetired }));
// The driver observes the wrapper's failure status above; its own assertions run in Vitest.
process.exitCode = 0;
`;
