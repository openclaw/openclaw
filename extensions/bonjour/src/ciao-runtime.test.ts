import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("loads Ciao without process patches and isolates responder diagnostics", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
import { createRequire } from "node:module";
await import("node:worker_threads");
const before = {
  emit: process.emit,
  exit: process.exit,
  cwd: process.cwd,
  chdir: process.chdir,
  prepareStackTrace: Error.prepareStackTrace,
  log: console.log,
  warn: console.warn,
  error: console.error,
};
const ciao = await import("@homebridge/ciao/native.js");
assert.equal(ciao.getResponder, createRequire(import.meta.url)("@homebridge/ciao/native.js").getResponder);
const alphaMessages = [];
const betaMessages = [];
const logger = (messages) => {
  const destination = {
    log: (...values) => messages.push(values),
    warn: (...values) => messages.push(values),
    error: (...values) => messages.push(values),
  };
  return Object.assign(destination, { sink: { destination } });
};
// Restrict discovery to loopback; the reserved address exercises the logger.
// Disabling both address families avoids opening multicast sockets.
const options = { interface: ["127.0.0.1", "192.0.2.1"], advertiseIpv4: false, advertiseIpv6: false };
const alpha = ciao.getResponder({ ...options, logger: logger(alphaMessages) });
const beta = ciao.getResponder({ ...options, logger: logger(betaMessages) });
assert.notEqual(alpha, beta);
assert.equal(alphaMessages.length, 1);
assert.equal(betaMessages.length, 1);
assert.match(alphaMessages[0][0], /couldn't find a matching interface/);
assert.match(betaMessages[0][0], /couldn't find a matching interface/);
const service = alpha.createService({ name: "fixture", type: "openclaw-gw", port: 18789 });
assert.equal(service.getFQDN(), "fixture._openclaw-gw._tcp.local.");
service.updatePort(18790);
assert.equal(service.getPort(), 18790);
service.updateTxt({ transport: "gateway" }, true);
await service.destroy();
assert.equal(service.isDestroyed(), true);
await Promise.all([alpha.shutdown(), beta.shutdown()]);
assert.equal(process.emit, before.emit);
assert.equal(process.exit, before.exit);
assert.equal(process.cwd, before.cwd);
assert.equal(process.chdir, before.chdir);
assert.equal(Error.prepareStackTrace, before.prepareStackTrace);
assert.equal(console.log, before.log);
assert.equal(console.warn, before.warn);
assert.equal(console.error, before.error);
console.log("ciao import, logger isolation, and service lifecycle passed");`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(output.trim()).toBe("ciao import, logger isolation, and service lifecycle passed");
});
