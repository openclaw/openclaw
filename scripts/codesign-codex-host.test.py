#!/usr/bin/env python3
"""Exercise the real runtime-signing loop with only codesign/signing I/O stubbed."""
import os
import json
import pathlib
import plistlib
import re
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('codesign-mac-app.sh')
SOURCE = SCRIPT.read_text()
START = SOURCE.index('RUNTIME_ROOT="$APP_BUNDLE/Contents/Resources/runtime"')
END = SOURCE.index('done < "$NATIVE_INVENTORY"', START) + len('done < "$NATIVE_INVENTORY"')
LOOP = SOURCE[START:END]
JIT_PLIST = re.search(r'cat > "\$ENT_TMP_JIT" <<\x27PLIST\x27\n(.*?)\nPLIST', SOURCE, re.S).group(1)


class CodexHostSigning(unittest.TestCase):
    def test_native_host_dispatch_preserves_jit_without_broadening_other_payloads(self):
        with tempfile.TemporaryDirectory(prefix='codex-signing-', dir=os.environ.get('TMPDIR')) as temporary:
            root = pathlib.Path(temporary)
            app = root / 'OpenClaw.app'
            runtime = app / 'Contents/Resources/runtime'
            jit = root / 'jit.plist'
            jit.write_text(JIT_PLIST)
            inventory = root / 'inventory'
            # Independently captured published npm layout, not a copy of the signer patterns.
            layout = json.loads((SCRIPT.parent.parent / "test/fixtures/codex-native-layout.json").read_text())
            arm, x64 = layout["platforms"]
            hosts = [
                "node_modules/" + arm["alias"] + "/" + arm["host"],
                "node_modules/@openai/codex/node_modules/" + x64["alias"] + "/" + x64["host"],
                "node_modules/@openai/codex/" + arm["host"],
                "node_modules/@openai/codex/" + x64["host"],
            ]
            ordinary = [
                'node_modules/unrelated/codex-code-mode-host',
                'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
                'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host',
                # The original candidate assumed a codex/ subdirectory; it must stay plain.
                'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex-code-mode-host',
            ]
            claude = 'lib/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
            entries = [('executable', name) for name in hosts + ordinary + ['bin/bun', claude]]
            entries.append(('library', hosts[0] + '.dylib'))
            inventory.write_bytes(b''.join(kind.encode() + b'\0' + str(runtime / name).encode() + b'\0'
                                           for kind, name in entries))
            environment = dict(os.environ, APP_BUNDLE=str(app), NATIVE_INVENTORY=str(inventory),
                               ENT_TMP_JIT=str(jit), ENT_TMP_BUN=str(root / 'bun.plist'))
            # No app is signed and no package code executes: these stubs observe real dispatch arguments.
            stubs = '''set -euo pipefail
sign_item() { printf 'signed\\t%s\\t%s\\n' "$1" "$2"; }
sign_plain_item() { printf 'plain\\t%s\\n' "$1"; }
codesign() { [[ "$1" == --verify && "$2" == --strict ]]; }
'''
            result = subprocess.run(['/bin/bash', '-c', stubs + LOOP], env=environment,
                                    text=True, capture_output=True, check=True, timeout=10)
            rows = [line.split('\t') for line in result.stdout.splitlines()]
            actual = {row[1]: row for row in rows}
            self.assertEqual(len(rows), len(entries))
            for host in hosts:
                self.assertEqual(actual[str(runtime / host)], ['signed', str(runtime / host), str(jit)])
            for name in ordinary + [hosts[0] + '.dylib']:
                self.assertEqual(actual[str(runtime / name)], ['plain', str(runtime / name)])
            self.assertEqual(actual[str(runtime / 'bin/bun')][-1], environment['ENT_TMP_BUN'])
            self.assertEqual(actual[str(runtime / claude)][-1], str(jit))
            # The exact allowlisted name must still be plain when inventory marks it as a library.
            inventory.write_bytes(b'library\0' + str(runtime / hosts[0]).encode() + b'\0')
            library = subprocess.run(['/bin/bash', '-c', stubs + LOOP], env=environment,
                                     text=True, capture_output=True, check=True, timeout=10)
            self.assertEqual(library.stdout.strip().split('\t'), ['plain', str(runtime / hosts[0])])
            entitlements = plistlib.loads(jit.read_bytes())
            self.assertTrue(entitlements['com.apple.security.cs.allow-jit'])
            self.assertTrue(entitlements['com.apple.security.cs.allow-unsigned-executable-memory'])
            self.assertNotIn('com.apple.security.cs.disable-library-validation', entitlements)


if __name__ == '__main__':
    unittest.main(verbosity=2)
