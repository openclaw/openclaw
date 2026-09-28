import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../ui/native-control-auth.js", import.meta.url), "utf8");
const config = { origin: "https://gateway.example", base: "/control", gatewayUrl: "wss://gateway.example/control" };
const challenge = { id: "request", nonce: "server-nonce", signedAt: 1800000000000 };
function fixture({ origin = config.origin, pathname = "/control/chat", child = false, legacyAuth = {}, invoke = async () => ({id: challenge.id, result: {}}) } = {}) {
  const listeners = new Map();
  const window = { addEventListener: (type, listener) => listeners.set(type, listener), __TAURI_INTERNALS__: { invoke } };
  window.top = child ? {} : window;
  const location = { origin, pathname };
  new Function("window", "location", `return (${source});`)(window, location)({ ...config, legacyAuth });
  return { window, location, ready: (token = "document-token") => listeners.get("openclaw:gateway-ready")?.({detail: {token}}) };
}

test("bridge only installs in the configured top-level dashboard without bootstrap credentials", () => {
  for (const options of [{ origin: "https://other.example" }, { pathname: "/control-other" }, { child: true }]) {
    const {window} = fixture(options);
    assert.equal(window.OpenClawNativeGatewayAuth, undefined);
    assert.equal(window.__OPENCLAW_NATIVE_CONTROL_AUTH__, undefined);
  }
  const {window} = fixture();
  assert.deepEqual(window.__OPENCLAW_NATIVE_CONTROL_AUTH__, { gatewayUrl: config.gatewayUrl, nativeConnectAuth: true });
});

test("accepted shared bootstrap fields remain usable by released UIs without replacing native signing", () => {
  for (const legacyAuth of [{token: "accepted-token"}, {password: "accepted-password"}, {}]) {
    const {window} = fixture({legacyAuth});
    assert.deepEqual(window.__OPENCLAW_NATIVE_CONTROL_AUTH__, {
      gatewayUrl: config.gatewayUrl, ...legacyAuth,
      ...("password" in legacyAuth ? {token: null} : {}), nativeConnectAuth: true,
    });
    assert.equal(typeof window.OpenClawNativeGatewayAuth.postMessage, "function");
  }
});

test("challenge waits for document readiness and uses its native route token", async () => {
  let calls = 0;
  const expected = { id:challenge.id, result:{ device:{ signature:"signed" } } };
  const fixtureValue = fixture({invoke:async (command, args) => {
    calls++;
    assert.equal(command, "gateway_request");
    assert.deepEqual(args, { message: { type:"connectAuth", challenge }, token:"current-document" });
    return expected;
  }});
  const pending = fixtureValue.window.OpenClawNativeGatewayAuth.postMessage(JSON.stringify(challenge));
  await Promise.resolve();
  assert.equal(calls, 0);
  fixtureValue.ready("current-document");
  assert.deepEqual(await pending, expected);
  assert.equal(calls, 1);
});

test("retired document or changed origin discards late native credentials", async () => {
  for (const invalidate of [value => value.ready("replacement-document"), value => { value.location.origin = "https://other.example"; }]) {
    let reply;
    let entered;
    const invoked = new Promise(resolve => { entered = resolve; });
    const value = fixture({ invoke: () => { entered(); return new Promise(resolve => {reply = resolve;}); } });
    value.ready();
    const pending = value.window.OpenClawNativeGatewayAuth.postMessage(JSON.stringify(challenge));
    await invoked;
    invalidate(value);
    reply({id:challenge.id, result:{auth:{deviceToken:"not-for-retired-document"}}});
    const response = await pending;
    assert.equal(response.id, challenge.id);
    assert.match(response.error, /document changed/);
    assert.equal(response.result, undefined);
  }
});

test("native failures remain explicit without a browser-identity fallback", async () => {
  const value = fixture({invoke: async () => {throw new Error("Native Gateway grant unavailable");}});
  value.ready();
  const response = await value.window.OpenClawNativeGatewayAuth.postMessage(JSON.stringify(challenge));
  assert.equal(response.id, challenge.id);
  assert.match(response.error, /grant unavailable/);
  assert.equal(response.result, undefined);
});
