"""Exercise the exact native-proof dashboard's report ordering without a display."""

import subprocess
import unittest

from desktop_sharing import DASHBOARD


REPORT_ORDER_RUNNER = r"""
const assert = require('node:assert/strict');
const vm = require('node:vm');
const requests = [];
const elements = new Map();
const window = {
  webkit: {messageHandlers: {openclawDeviceSettings: {postMessage: () => new Promise(() => {})}}},
  addEventListener() {},
};
const context = vm.createContext({
  window,
  location: {pathname: '/fixture/'},
  crypto: {randomUUID: () => 'synthetic-dashboard'},
  document: {getElementById(id) {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id);
  }},
  fetch(url, options) {
    return new Promise((resolve, reject) => requests.push({url, options, resolve, reject}));
  },
});
vm.runInContext(process.argv[1], context);
const flush = () => new Promise(setImmediate);
const snapshot = (revision, state) => ({
  contract: 1, revision, capabilities: {desktopSharingEnabled: false}, desktopSharing: {state},
});
(async () => {
  window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__ = snapshot(6, 'starting');
  const first = vm.runInContext('report()', context);
  const firstOutcome = first.then(value => ({value}), error => ({error}));
  const stopped = snapshot(8, 'off');
  window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__ = stopped;
  const second = vm.runInContext('report("synthetic diagnostic")', context);
  let secondSettled = false;
  const secondOutcome = second.then(() => { secondSettled = true; });
  stopped.revision = 99;
  window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__ = snapshot(10, 'starting');
  await flush();
  assert.equal(requests.length, 1, 'a newer report must wait for the previous HTTP acknowledgement');
  assert.equal(requests[0].url, '/fixture/desktop-report');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(JSON.parse(requests[0].options.body).snapshot.revision, 6);
  assert.equal(secondSettled, false);
  const failure = new Error('synthetic first report failure');
  if (process.argv[2] === 'reject') requests[0].reject(failure);
  else requests[0].resolve({ok: true});
  const outcome = await firstOutcome;
  if (process.argv[2] === 'reject') assert.equal(outcome.error, failure);
  else assert.deepEqual(outcome, {value: undefined});
  await flush();
  assert.equal(requests.length, 2, 'a failed report must not poison later reports');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    instance: 'synthetic-dashboard', path: '/fixture/', snapshot: snapshot(8, 'off'),
    unsupported: null, trustedClicks: 0, retainedAuthority: false, staleWriteRejected: null,
    error: 'synthetic diagnostic',
  });
  assert.equal(secondSettled, false, 'each report must await its own HTTP acknowledgement');
  requests[1].resolve({ok: true});
  await secondOutcome;
  assert.equal(secondSettled, true);
  process.stdout.write('report ordering checks completed\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
"""


class DesktopSharingReportsTest(unittest.TestCase):
    def exercise(self, first_outcome):
        script = DASHBOARD.split("<script>", 1)[1].split("</script>", 1)[0]
        result = subprocess.run(
            ["node", "-e", REPORT_ORDER_RUNNER, script, first_outcome],
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "report ordering checks completed\n")

    def test_reports_wait_for_ack_and_keep_the_snapshot_captured_at_call_time(self):
        self.exercise("resolve")

    def test_a_rejected_report_reaches_its_caller_without_poisoning_later_reports(self):
        self.exercise("reject")


if __name__ == "__main__":
    unittest.main()
