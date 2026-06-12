const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the service at a temp dir BEFORE requiring it, and make sure the
// send opt-in is not inherited from the environment. Requiring index.js
// must not start the watcher, the HTTP server, or the Contacts load —
// that is what the require.main guard provides.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-service-test-'));
process.env.OPENCLAW_IMESSAGE_DATA_DIR = tempRoot;
delete process.env.OPENCLAW_IMESSAGE_SEND_OPTIN;

const { __test } = require('./index');
const { processRequestFile, REQUEST_FILE, RESPONSE_FILE, DATA_DIR } = __test;

assert.equal(DATA_DIR, tempRoot, 'tests must run against the temp data dir, never the live spool');

function writeRequest(request) {
  fs.writeFileSync(REQUEST_FILE, JSON.stringify(request));
}

function readResponse() {
  return JSON.parse(fs.readFileSync(RESPONSE_FILE, 'utf8'));
}

function clearSpool() {
  for (const file of [REQUEST_FILE, REQUEST_FILE + '.processing', RESPONSE_FILE]) {
    fs.rmSync(file, { force: true });
  }
}

function freshTimestamp() {
  return new Date().toISOString();
}

test('send is disabled by default and never reaches dispatch', async () => {
  clearSpool();
  writeRequest({ action: 'send', contact: 'Anyone', text: 'hi', requested_at: freshTimestamp() });
  await processRequestFile();

  const response = readResponse();
  assert.equal(response.success, false);
  assert.equal(response.code, 'send_disabled');
  assert.equal(response.action, 'send');
  assert.equal(response.data, undefined, 'no send result data may exist');
});

test('request file is consumed before dispatch', async () => {
  clearSpool();
  writeRequest({ action: 'send', contact: 'Anyone', text: 'hi', requested_at: freshTimestamp() });
  await processRequestFile();

  assert.equal(fs.existsSync(REQUEST_FILE), false, 'request file must be gone after processing');
  assert.equal(fs.existsSync(REQUEST_FILE + '.processing'), false, 'no processing residue may remain');
});

test('a FRESH request is not replayed on a simulated service respawn', async () => {
  clearSpool();
  // Fresh (not stale) request: this is the crash-mid-send replay window.
  writeRequest({ action: 'send', contact: 'Anyone', text: 'hi', requested_at: freshTimestamp() });

  await processRequestFile(); // first startup processes it
  assert.equal(fs.existsSync(RESPONSE_FILE), true);

  fs.rmSync(RESPONSE_FILE); // forget the response, then simulate respawn
  await processRequestFile(); // startup call on respawn

  assert.equal(fs.existsSync(RESPONSE_FILE), false, 'respawn must not re-process the consumed request');
  assert.equal(fs.existsSync(REQUEST_FILE), false);
});

test('stale requested_at fails closed with an error response and is consumed', async () => {
  clearSpool();
  const staleTs = new Date(Date.now() - 60000).toISOString();
  writeRequest({ action: 'send', contact: 'Anyone', text: 'hi', requested_at: staleTs });
  await processRequestFile();

  const response = readResponse();
  assert.equal(response.success, false);
  assert.equal(response.code, 'stale_request');
  assert.equal(fs.existsSync(REQUEST_FILE), false);
});

test('missing requested_at fails closed', async () => {
  clearSpool();
  writeRequest({ action: 'recent', limit: 5 });
  await processRequestFile();

  const response = readResponse();
  assert.equal(response.success, false);
  assert.equal(response.code, 'invalid_requested_at');
});

test('malformed requested_at fails closed', async () => {
  clearSpool();
  writeRequest({ action: 'recent', limit: 5, requested_at: 'garbage' });
  await processRequestFile();

  const response = readResponse();
  assert.equal(response.success, false);
  assert.equal(response.code, 'invalid_requested_at');
});

test('request_id is echoed in responses', async () => {
  clearSpool();
  writeRequest({
    action: 'send',
    contact: 'Anyone',
    text: 'hi',
    requested_at: freshTimestamp(),
    request_id: 'req-abc-123'
  });
  await processRequestFile();

  const response = readResponse();
  assert.equal(response.request_id, 'req-abc-123');
});

test('response file is written with mode 0600 even when replacing a looser file', async () => {
  clearSpool();
  fs.writeFileSync(RESPONSE_FILE, '{}', { mode: 0o644 });
  fs.chmodSync(RESPONSE_FILE, 0o644);

  writeRequest({ action: 'send', contact: 'Anyone', text: 'hi', requested_at: freshTimestamp() });
  await processRequestFile();

  const mode = fs.statSync(RESPONSE_FILE).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('unknown actions still produce a normal error response and are consumed', async () => {
  clearSpool();
  writeRequest({ action: 'definitely_not_an_action', requested_at: freshTimestamp() });
  await processRequestFile();

  const response = readResponse();
  assert.equal(response.success, false);
  assert.match(response.error, /Unknown action/);
  assert.equal(fs.existsSync(REQUEST_FILE), false);
});
