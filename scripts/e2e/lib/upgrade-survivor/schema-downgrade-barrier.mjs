// Test-only preload: freeze the candidate before its Gateway can accept a connection.
import fs from "node:fs";
import { Server } from "node:net";

const portText = process.env.OPENCLAW_SCHEMA_DOWNGRADE_PORT;
const port = Number(portText);
const sentinel = process.env.OPENCLAW_SCHEMA_DOWNGRADE_SENTINEL;
if (
  !/^\d+$/u.test(portText ?? "") ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !sentinel
) {
  throw new Error("schema downgrade barrier requires an exact TCP port and sentinel path");
}

const nativeListen = Reflect.get(Server.prototype, "listen");
if (typeof nativeListen !== "function") {
  throw new Error("schema downgrade barrier cannot locate the native listen method");
}
Server.prototype.listen = function (...args) {
  const value = typeof args[0] === "object" && args[0] !== null ? args[0].port : args[0];
  const requestedPort =
    typeof value === "number" || (typeof value === "string" && /^\d+$/u.test(value))
      ? Number(value)
      : null;
  if (requestedPort !== port) {
    return Reflect.apply(nativeListen, this, args);
  }
  fs.writeFileSync(sentinel, `${JSON.stringify({ pid: process.pid, port })}\n`);
  // Do not return into later startup work or emit a synthetic listening event.
  // The controller owns SIGKILL of this process group and waits before copying stores.
  const parked = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    Atomics.wait(parked, 0, 0);
  }
};
