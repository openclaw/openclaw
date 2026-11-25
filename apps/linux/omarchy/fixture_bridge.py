"""Synthetic CLI and desktop peers for the real widget worker protocol tests."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time


def record(transport, method, params):
    with open(Path(os.environ['FIXTURE_DIR']) / (transport + '.jsonl'), 'a') as stream:
        stream.write(json.dumps({'method': method, 'params': params}) + '\n')


def response(method, params):
    if method == 'agents.list':
        return {'defaultId': 'research', 'selectionRequired': True, 'agents': [
            {'id': 'research', 'name': 'Research', 'model': {'primary': 'example/model'}},
            {'id': 'builder', 'name': 'Builder'}]}
    if method == 'sessions.list':
        now = int(time.time() * 1000)
        rows = [
            {'key': 'agent:research:report', 'agentId': 'research', 'label': 'Release research',
             'hasActiveRun': True, 'updatedAt': now - 60000,
             'observerDigest': {'health': 'on-track', 'headline': 'Comparing release notes'},
             'lastMessagePreview': 'Summarize changes.', 'model': 'example/model', 'totalTokens': 12500},
            {'key': os.environ.get('FIXTURE_SESSION_KEY', 'agent:builder:review'), 'agentId': 'builder', 'label': 'Review the widget',
             'status': 'done', 'unread': False, 'updatedAt': now - 180000,
             'observerDigest': {'health': 'waiting-on-user', 'headline': 'Choose a layout'}},
            {'key': 'agent:research:notes', 'agentId': 'research', 'status': 'done',
             'unread': True, 'updatedAt': now - 3600000},
            {'key': 'agent:builder:choice', 'agentId': 'builder', 'status': 'done',
             'agentStatus': {'attention': 'needs-user'}, 'updatedAt': now - 4000000}]
        if params.get('activeOnly'):
            rows = rows[:1]
        if params.get('includeGlobal'):
            rows.extend([
                {'key': 'global', 'agentId': 'research', 'label': 'Research global',
                 'hasActiveRun': True, 'updatedAt': now, 'totalTokens': 700},
                {'key': 'global', 'agentId': 'builder', 'label': 'Builder global',
                 'hasActiveRun': True, 'updatedAt': now, 'totalTokens': 1300}])
        return {'sessions': rows,
                'hasMore': False, 'path': 'private state path not for presentation'}
    if method == 'chat.send':
        return {'status': 'started', 'runId': 'run-fixture'}
    if method == 'sessions.create':
        return {'key': 'agent:' + params['agentId'] + ':new-fixture',
                'runStarted': True, 'status': 'started', 'runId': 'run-fixture'}
    raise ValueError(method)


def cli():
    args = sys.argv[2:]
    config = Path(os.environ['FIXTURE_DIR']) / 'desktop.json'
    state = json.loads(config.read_text())
    url = state['cliUrl']
    if args[0] == 'status':
        record('status', 'status', args[1:])
        if state.get('changeAfterStatus'):
            state['cliUrl'] = state.pop('changeAfterStatus')
            temporary = config.with_suffix('.status.tmp')
            temporary.write_text(json.dumps(state))
            temporary.replace(config)
        print(json.dumps({'gateway': {'url': url}}))
        return
    method = args[2]
    expected = args[args.index('--expect-url') + 1] if '--expect-url' in args else None
    if expected != url:
        record('guard', method, {'expected': expected, 'actual': url})
        print('Gateway destination changed', file=sys.stderr)
        sys.exit(1)
    params = json.loads(args[args.index('--params') + 1])
    record('cli', method, params)
    if os.environ.get('FIXTURE_SLOW') and method == 'agents.list':
        (Path(os.environ['FIXTURE_DIR']) / 'snapshot-entered').touch()
        time.sleep(5)
    if os.environ.get('FIXTURE_FAIL') and method in ('chat.send', 'sessions.create'):
        print('private connection detail must not reach UI', file=sys.stderr)
        sys.exit(1)
    print(json.dumps(response(method, params)))


XML = '''<node><interface name="ai.openclaw.Desktop1">
<method name="GetState"><arg type="s" direction="out"/></method>
<method name="ClaimPresenter"><arg type="s" direction="in"/></method>
<method name="Snapshot"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<method name="SendPrompt">
<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/>
<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/>
</method>
<method name="Activate"><arg type="s" direction="in"/><arg type="s" direction="in"/>
<arg type="s" direction="in"/><arg type="s" direction="in"/></method>
</interface></node>'''


def desktop(mode):
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    config = Path(os.environ['FIXTURE_DIR']) / 'desktop.json'

    def handle(connection, sender, path, interface, method, arguments, invocation):
        args = arguments.unpack()
        record('desktop', method, args)
        state = json.loads(config.read_text())
        if method == 'GetState':
            result = {'version': 1, 'routeId': state['route'], 'ready': state['ready']}
        elif args[0] != state['route']:
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', 'Gateway changed')
            return
        elif method in ('ClaimPresenter', 'Activate'):
            invocation.return_value(GLib.Variant('()', ()))
            return
        elif not state['ready'] or (state.get('fail') and method == 'SendPrompt'):
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed',
                                         'private connection detail must not reach UI')
            return
        elif method == 'Snapshot':
            result = {'agents': response('agents.list', {}),
                      'recent': response('sessions.list', {'includeGlobal': True}),
                      'active': response('sessions.list', {'activeOnly': True, 'includeGlobal': True})}
        elif method == 'SendPrompt':
            params = {'agentId': args[1], 'sessionKey': args[2],
                      'message': args[3], 'idempotencyKey': args[4]}
            result = response('chat.send' if args[2] else 'sessions.create', params)
        else:
            raise ValueError(method)
        invocation.return_value(GLib.Variant('(s)', (json.dumps(result),)))

    if mode != 'legacy':
        interface = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]
        bus.register_object('/ai/openclaw/Desktop', interface, handle, None, None)
    name = 'ai.openclaw.linux.SingleInstance' if mode == 'legacy' else 'ai.openclaw.Desktop'
    bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                  'RequestName', GLib.Variant('(su)', (name, 0)), None,
                  Gio.DBusCallFlags.NONE, 2000, None)
    loop = GLib.MainLoop()
    threading.Thread(target=loop.run, daemon=True).start()
    return bus, loop


def launch():
    # This process and the worker inherit only the private dbus-run-session bus.
    # Keeping the fixture alive retains its bus name until the worker exits.
    peer = desktop(sys.argv[2]) if sys.argv[2] != 'cli' else None
    worker = subprocess.Popen([sys.executable, str(Path(__file__).with_name('bridge.py'))])
    try:
        sys.exit(worker.wait())
    finally:
        if peer:
            peer[1].quit()


if __name__ == '__main__':
    if sys.argv[1] == 'cli':
        cli()
    elif sys.argv[1] == 'terminal':
        record('terminal', 'launch', sys.argv[2:])
    else:
        launch()
