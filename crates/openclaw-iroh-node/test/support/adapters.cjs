// Uniform adapter over the two Node iroh bindings so every check runs the same code: "own"
// (this crate, Buffer I/O) and "number0" (@number0/iroh, Array<number> I/O). Streams expose
// write(buf), finish(), reset(code), read(max) -> Buffer | null.
"use strict";
const path = require("node:path");

const OWN_DIR = path.resolve(__dirname, "../..");

/** Loads the named binding ("own" or "number0") and returns { name, bind }. */
function load(name) {
  if (name === "own") {
    return ownAdapter(require(OWN_DIR));
  }
  if (name === "number0") {
    return number0Adapter(require(resolveNumber0()));
  }
  throw new Error("unknown binding " + name);
}

/** Resolves @number0/iroh from IROH_NUMBER0_DIR (a node_modules parent) or normal lookup. */
function resolveNumber0() {
  const paths = process.env.IROH_NUMBER0_DIR ? [process.env.IROH_NUMBER0_DIR] : undefined;
  return require.resolve("@number0/iroh", paths ? { paths } : undefined);
}

/** True when @number0/iroh can be loaded on this host. */
function hasNumber0() {
  try {
    resolveNumber0();
    return true;
  } catch {
    return false;
  }
}

// Own binding: already Buffer-based, only flattens { send, recv } into one stream object.
function ownAdapter(m) {
  const wrapBi = (bi) => ({
    write: (b) => bi.send.write(b),
    finish: () => bi.send.finish(),
    reset: (code) => bi.send.reset(code),
    read: (max) => bi.recv.read(max),
  });
  const wrapConn = (c) => ({
    raw: c,
    remoteId: () => c.remoteId(),
    openBi: async () => wrapBi(await c.openBi()),
    acceptBi: async () => wrapBi(await c.acceptBi()),
    close: (code, reason) => c.close(code, reason),
    closed: () => c.closed(),
    pathKind: () => c.pathKind(),
  });
  return {
    name: "own",
    async bind({ secretKey, relayUrl, alpns, ipTransports, bindAddr }) {
      const ep = await m.bind({ secretKey, relayUrl, alpns, ipTransports, bindAddr });
      return {
        id: () => ep.id(),
        directAddrs: () => loopbackAddrs(ep.boundSockets()),
        online: () => ep.online(),
        accept: async () => {
          const c = await ep.accept();
          return c && wrapConn(c);
        },
        connect: async (id, alpn, opts) => wrapConn(await ep.connect(id, alpn, opts)),
        close: () => ep.close(),
      };
    },
  };
}

// @number0/iroh: every byte crosses as Array<number>.
function number0Adapter(m) {
  const { Endpoint, EndpointAddr, EndpointId, RelayMode } = m;
  const wrapBi = (bi) => ({
    write: (b) => bi.send.writeAll(Array.from(b)),
    finish: () => bi.send.finish(),
    reset: (code) => bi.send.reset(BigInt(code)),
    read: async (max) => {
      const a = await bi.recv.read(max);
      return a.length === 0 ? null : Buffer.from(a);
    },
  });
  const wrapConn = (c) => ({
    raw: c,
    remoteId: () => c.remoteId().toString(),
    openBi: async () => wrapBi(await c.openBi()),
    acceptBi: async () => wrapBi(await c.acceptBi()),
    close: (code, reason) => c.close(BigInt(code), Array.from(Buffer.from(reason))),
    closed: async () => ({ reason: await c.closed() }),
    pathKind: () => {
      const p = c.paths().find((x) => x.isSelected);
      return !p ? "none" : p.isIp ? "direct" : p.isRelay ? "relay" : "none";
    },
  });
  return {
    name: "number0",
    async bind({ secretKey, relayUrl, alpns, ipTransports, bindAddr }) {
      if (ipTransports === false) {
        throw new Error("@number0/iroh cannot disable IP transports");
      }
      const b = Endpoint.builder();
      b.applyMinimal();
      b.secretKey(Array.from(secretKey));
      if (alpns) {
        b.alpns(alpns.map((a) => Array.from(a)));
      }
      b.relayMode(relayUrl ? RelayMode.customFromUrls([relayUrl]) : RelayMode.disabled());
      if (bindAddr) {
        b.bindAddr(bindAddr);
      }
      const ep = await b.bind();
      return {
        id: () => ep.id().toString(),
        directAddrs: () => loopbackAddrs(ep.boundSockets()),
        online: () => ep.online(),
        accept: async () => {
          const inc = await ep.acceptNext();
          return inc && wrapConn(await (await inc.accept()).connect());
        },
        connect: async (id, alpn, opts = {}) => {
          const addr = new EndpointAddr(
            EndpointId.fromString(id),
            opts.relayUrl || null,
            opts.directAddrs || [],
          );
          return wrapConn(await ep.connect(addr, Array.from(alpn)));
        },
        close: () => ep.close(),
      };
    },
  };
}

/** IPv4 bound sockets rewritten to 127.0.0.1 so peers on this host can dial them. */
function loopbackAddrs(socks) {
  return socks
    .filter((s) => !s.startsWith("["))
    .map((s) => s.replace(/^0\.0\.0\.0:/, "127.0.0.1:"));
}

module.exports = { load, hasNumber0, loopbackAddrs };
