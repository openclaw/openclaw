"""Exercise widget stdin/stdout against isolated CLI and real D-Bus peers."""
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

FIXTURE = Path(__file__).with_name('fixture_bridge.py').resolve()


class BridgeContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='openclaw-omarchy-test-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.config = self.folder / 'desktop.json'
        self.configure_desktop()
        cli = self.folder / 'openclaw'
        for name, mode in (('openclaw', 'cli'), ('omarchy-launch-terminal', 'terminal')):
            executable = self.folder / name
            executable.write_text('#!' + sys.executable + '\nimport os, sys\nos.execv(' +
                                  repr(sys.executable) + ', [' + repr(sys.executable) + ', ' +
                                  repr(str(FIXTURE)) + ', ' + repr(mode) + ', *sys.argv[1:]])\n')
            executable.chmod(0o700)
        # Avoid inheriting real CLI/Gateway credentials or the user's desktop bus.
        self.env = {'PATH': str(self.folder) + ':/usr/bin:/bin', 'HOME': str(self.folder),
                    'XDG_CONFIG_HOME': str(self.folder / 'config'),
                    'OPENCLAW_DESKTOP_CLI': str(cli), 'FIXTURE_DIR': str(self.folder),
                    'PYTHONUNBUFFERED': '1'}
        self.messages = queue.Queue()
        self.serial = 0

    def configure_desktop(self, route='remote-fixture/1', ready=True, fail=False,
                          cli_url='ws://127.0.0.1:18789', change_after_status=None):
        # Atomic replacement also lets a test switch the live fixture's route.
        temporary = self.config.with_suffix('.tmp')
        temporary.write_text(json.dumps({'route': route, 'ready': ready, 'fail': fail,
                                         'cliUrl': cli_url, 'changeAfterStatus': change_after_status}))
        temporary.replace(self.config)

    def start(self, mode='cli'):
        self.worker = subprocess.Popen(
            ['dbus-run-session', '--', sys.executable, str(FIXTURE), 'launch', mode],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=self.env, start_new_session=True)
        self.addCleanup(self.stop)
        threading.Thread(target=self.read_output, daemon=True).start()
        self.state = self.receive(lambda item: item.get('op') == 'state')
        return self.state

    def read_output(self):
        for line in self.worker.stdout:
            try:
                self.messages.put(json.loads(line))
            except ValueError:
                self.messages.put({'invalidOutput': line})
        self.messages.put({'eof': True})

    def stop(self):
        self.worker.stdin.close()
        try:
            self.worker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.worker.pid, signal.SIGKILL)
            self.worker.wait(timeout=5)
        # A terminated worker may leave a detached fixture CLI running.
        # This private process group contains only this test's fixture tree.
        try:
            os.killpg(self.worker.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.worker.stdout.close()
        self.worker.stderr.close()

    def receive(self, predicate):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                item = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                break
            self.assertNotIn('invalidOutput', item)
            if item.get('eof'):
                self.fail('Worker exited: ' + self.worker.stderr.read())
            if predicate(item):
                return item
        self.fail('Timed out waiting for worker protocol response')

    def request(self, operation, **params):
        self.serial += 1
        request = {'id': self.serial, 'op': operation, 'routeId': self.state['routeId'], **params}
        self.worker.stdin.write(json.dumps(request) + '\n')
        self.worker.stdin.flush()
        return self.receive(lambda item: item.get('id') == self.serial)

    def calls(self, transport='cli', method=None):
        path = self.folder / (transport + '.jsonl')
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return [row for row in rows if method is None or row['method'] == method]

    def prompt(self, **params):
        return self.request('send', **{'agentId': 'builder', 'sessionKey': 'agent:builder:review',
                                      'message': 'Draft a checklist', **params})

    def assert_global_sessions(self, snapshot):
        rows = [row for row in snapshot['sessions'] if row['key'] == 'global']
        self.assertEqual(len(rows), 2)
        self.assertEqual({row['agentId']: row['totalTokens'] for row in rows},
                         {'research': 700, 'builder': 1300})
        self.assertEqual(len({row['id'] for row in snapshot['sessions']}), 6)

    def test_cli_snapshot_preserves_selection_attention_and_deduplicates_pages(self):
        self.assertFalse(self.start()['desktop'])
        result = self.request('snapshot')
        self.assertTrue(result['ok'])
        self.assertTrue(result['selectionRequired'])
        self.assertEqual(len(result['sessions']), 6)
        self.assert_global_sessions(result)
        rows = {row['key']: row for row in result['sessions']}
        self.assertTrue(rows['agent:builder:review']['waiting'])
        for key in ('agent:builder:review', 'agent:builder:choice', 'agent:research:notes'):
            self.assertTrue(rows[key]['attention'])
        self.assertEqual(rows['agent:research:report']['status'], 'running')
        self.assertNotIn('private state path', json.dumps(result))
        self.assertEqual({row['method'] for row in self.calls()}, {'agents.list', 'sessions.list'})

    def test_cli_prompt_preserves_literal_content_and_new_session_destination(self):
        self.start()
        marker = self.folder / 'must-not-exist'
        prompt = 'Explain $(touch ' + str(marker) + ') and `literal`\n"quoted" 🦞'
        self.assertTrue(self.prompt(message=prompt)['ok'])
        params = self.calls()[0]['params']
        self.assertEqual(params['message'], prompt)
        self.assertEqual(params['sessionKey'], 'agent:builder:review')
        self.assertFalse(params['deliver'])
        self.assertTrue(params['idempotencyKey'])
        self.assertFalse(marker.exists())
        result = self.prompt(sessionKey='')
        self.assertTrue(result['ok'])
        self.assertEqual(result['sessionKey'], 'agent:builder:new-fixture')
        self.assertEqual(self.calls()[1]['method'], 'sessions.create')
        self.assertEqual(self.calls()[1]['params']['agentId'], 'builder')
        self.assertTrue(self.prompt(sessionKey='global')['ok'])
        self.assertEqual(self.calls()[2]['params']['agentId'], 'builder')
        self.assertEqual(self.calls()[2]['params']['sessionKey'], 'global')

    def test_unicode_session_identity_survives_prompt_and_refresh(self):
        key = 'agent:builder:café-🦞'
        self.env['FIXTURE_SESSION_KEY'] = key
        self.start()
        before = next(row for row in self.request('snapshot')['sessions'] if row['key'] == key)
        result = self.prompt(sessionKey=key)
        self.assertTrue(result['ok'])
        self.assertEqual(result['sessionId'], before['id'])
        after = next(row for row in self.request('snapshot')['sessions'] if row['id'] == result['sessionId'])
        self.assertEqual((after['agentId'], after['key']), ('builder', key))
        self.assertTrue(self.prompt(sessionKey=after['key'])['ok'])
        created = self.prompt(sessionKey='')
        self.assertEqual(json.loads(created['sessionId']), ['builder', created['sessionKey']])

    def test_cli_session_activation_preserves_global_agent_owner(self):
        self.start()
        for index, (key, expected) in enumerate((('agent:builder:review', 'agent:builder:review'),
                                                  ('global', 'agent:builder:global')), 1):
            self.assertTrue(self.request('activate', action='session', sessionKey=key,
                                         agentId='builder')['ok'])
            # Terminal launch is detached; wait for its observable argument record.
            deadline = time.monotonic() + 3
            while len(self.calls('terminal')) < index and time.monotonic() < deadline:
                time.sleep(0.01)
            calls = self.calls('terminal')
            self.assertEqual(len(calls), index)
            self.assertEqual(calls[-1]['params'],
                             [self.env['OPENCLAW_DESKTOP_CLI'], 'tui', '--session', expected])
        self.assertEqual(self.calls(), [])

    def test_cli_route_change_rejects_prompt_from_previous_snapshot(self):
        self.start()
        self.assertTrue(self.request('snapshot')['ok'])
        self.configure_desktop(cli_url='wss://other-gateway.example')
        result = self.prompt()
        self.assertFalse(result['ok'])
        self.assertFalse(result['uncertain'])
        self.assertEqual(self.calls(method='chat.send'), [])
        self.assertEqual(self.calls(method='sessions.create'), [])

    def test_cli_expect_url_blocks_route_change_after_status_resolution(self):
        self.start()
        self.assertTrue(self.request('snapshot')['ok'])
        self.configure_desktop(change_after_status='wss://other-gateway.example')
        result = self.prompt()
        self.assertFalse(result['ok'])
        self.assertTrue(result['uncertain'])
        self.assertEqual(self.calls('guard'), [{'method': 'chat.send', 'params': {
            'expected': 'ws://127.0.0.1:18789', 'actual': 'wss://other-gateway.example'}}])
        self.assertEqual(self.calls(method='chat.send'), [])
        self.assertEqual(self.calls(method='sessions.create'), [])

    def test_cli_unknown_send_is_never_retried_and_redacts_diagnostics(self):
        self.env['FIXTURE_FAIL'] = '1'
        self.start()
        result = self.prompt()
        self.assertFalse(result['ok'])
        self.assertTrue(result['uncertain'])
        self.assertEqual(result['sessionKey'], 'agent:builder:review')
        self.assertNotIn('private connection detail', json.dumps(result))
        # A follow-up read is a protocol barrier after the failed send.
        self.assertTrue(self.request('snapshot')['ok'])
        self.assertEqual(len(self.calls(method='chat.send')), 1)

    def test_stdin_eof_exits_while_cli_snapshot_is_in_flight(self):
        self.env['FIXTURE_SLOW'] = '1'
        self.start()
        self.worker.stdin.write(json.dumps({'id': 1, 'op': 'snapshot',
                                             'routeId': self.state['routeId']}) + '\n')
        self.worker.stdin.flush()
        entered = self.folder / 'snapshot-entered'
        deadline = time.monotonic() + 3
        while not entered.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(entered.exists(), 'Snapshot must reach the slow CLI before closing stdin')
        self.worker.stdin.close()
        self.assertEqual(self.worker.wait(timeout=2), 0)
        self.assertEqual(self.calls(method='chat.send'), [])
        self.assertEqual(self.calls(method='sessions.create'), [])

    def test_invalid_prompt_never_reaches_gateway(self):
        self.start()
        for message in (' ', 'x' * 8001):
            with self.subTest(length=len(message)):
                result = self.prompt(message=message)
                self.assertFalse(result['ok'])
                self.assertFalse(result['uncertain'])
        self.assertEqual(self.calls(), [])

    def test_desktop_owns_snapshot_send_and_session_activation_without_cli(self):
        state = self.start('desktop')
        self.assertTrue(state['desktop'])
        self.assertFalse(state['yield'])
        self.assertTrue(state['ready'])
        snapshot = self.request('snapshot')
        self.assertTrue(snapshot['selectionRequired'])
        self.assert_global_sessions(snapshot)
        self.assertTrue(self.prompt()['ok'])
        self.assertTrue(self.prompt(sessionKey='')['ok'])
        for key in ('agent:builder:review', 'global'):
            self.assertTrue(self.request('activate', action='session',
                                         sessionKey=key, agentId='builder')['ok'])
        self.assertEqual([row['params'] for row in self.calls('desktop', 'Activate')], [
            ['remote-fixture/1', 'session', 'agent:builder:review', 'builder'],
            ['remote-fixture/1', 'session', 'global', 'builder']])
        calls = self.calls('desktop')
        self.assertTrue(any(row['method'] == 'ClaimPresenter' for row in calls))
        sends = self.calls('desktop', 'SendPrompt')
        self.assertEqual(len(sends), 2)
        self.assertEqual(sends[0]['params'][:4],
                         ['remote-fixture/1', 'builder', 'agent:builder:review', 'Draft a checklist'])
        self.assertEqual(sends[1]['params'][2], '')
        self.assertTrue(sends[0]['params'][4])
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.calls('status'), [])

    def test_disconnected_desktop_never_falls_back_to_cli(self):
        self.configure_desktop(ready=False)
        self.assertFalse(self.start('desktop')['ready'])
        self.assertFalse(self.request('snapshot')['ok'])
        self.assertFalse(self.prompt()['ok'])
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.calls('status'), [])

    def test_changed_desktop_route_rejects_stale_prompt_before_dispatch(self):
        self.start('desktop')
        self.configure_desktop(route='another-gateway/2')
        result = self.prompt()
        self.assertFalse(result['ok'])
        self.assertFalse(result['uncertain'])
        self.assertEqual(self.calls('desktop', 'SendPrompt'), [])
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.calls('status'), [])

    def test_unknown_desktop_send_never_retries_or_switches_to_cli(self):
        self.configure_desktop(fail=True)
        self.start('desktop')
        result = self.prompt()
        self.assertFalse(result['ok'])
        self.assertTrue(result['uncertain'])
        self.assertNotIn('private connection detail', json.dumps(result))
        self.assertTrue(self.request('snapshot')['ok'])
        self.assertEqual(len(self.calls('desktop', 'SendPrompt')), 1)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.calls('status'), [])

    def test_legacy_desktop_keeps_its_entry_and_blocks_cli_requests(self):
        state = self.start('legacy')
        self.assertTrue(state['desktop'])
        self.assertTrue(state['yield'])
        self.assertFalse(self.request('snapshot')['ok'])
        self.assertFalse(self.prompt()['ok'])
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.calls('status'), [])


if __name__ == '__main__':
    unittest.main()
