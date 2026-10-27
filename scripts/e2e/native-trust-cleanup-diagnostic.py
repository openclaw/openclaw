#!/usr/bin/env python3
"""Task-only Apple trust cleanup diagnostic on a disposable hosted Mac."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import ssl
import shlex
import threading
import sys
import time
import zipfile

archive, root = [Path(x).resolve() for x in sys.argv[1:]]
assert platform.system() == "Darwin" and os.environ.get("GITHUB_ACTIONS") == "true"
assert not root.exists()
root.mkdir(mode=0o700)
env = {k: os.environ[k] for k in ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"] if k in os.environ}
report = {"status": "running", "platform": platform.platform(), "commands": []}
serial = 0

def checkpoint():
    (root / "RESULTS.json").write_text(json.dumps(report, indent=2) + "\n")

def run(name, args, timeout=30, check=True):
    global serial
    serial += 1
    started = time.monotonic()
    command = {"name": name, "timeoutSeconds": timeout, "startedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    log = root / f"{serial:03d}-{name}.log"
    print("START", name, flush=True)
    result = subprocess.run([str(x) for x in args], env=env, capture_output=True, text=True, timeout=timeout)
    log.write_text(result.stdout + "\n[stderr]\n" + result.stderr)
    command.update(returncode=result.returncode, elapsedSeconds=time.monotonic() - started)
    report["commands"].append(command)
    checkpoint()
    print("DONE", name, result.returncode, flush=True)
    if check:
        assert result.returncode == 0, name
    return result

def bounded_security(name, args):
    started = time.monotonic()
    process = subprocess.Popen([str(x) for x in args],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    timed_out = False
    try:
        try:
            output, error = process.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            # Record only this task's command tree; do not sample unrelated processes.
            rows = subprocess.check_output(["ps", "-axo", "pid=,ppid=,uid=,comm="], env=env, text=True, timeout=10).splitlines()
            descendants = {process.pid}
            while True:
                found = {int(row.split()[0]) for row in rows if len(row.split()) >= 4 and int(row.split()[1]) in descendants}
                if found <= descendants:
                    break
                descendants |= found
            (root / (name + "-owned-processes.txt")).write_text("\n".join(row for row in rows if int(row.split()[0]) in descendants) + "\n")
            for pid in sorted(descendants):
                run(name + "-sample-" + str(pid), ["sudo", "-n", "sample", str(pid), "2", "-file", root / (name + "-sample-" + str(pid) + ".txt")], timeout=10, check=False)
            try:
                output, error = process.communicate(timeout=max(1, 180 - (time.monotonic() - started)))
            except subprocess.TimeoutExpired:
                timed_out = True
                # start_new_session gives this task an exclusive process group.
                run(name + "-kill-owned-group", ["sudo", "-n", "/bin/kill", "-KILL", "--", "-" + str(process.pid)], check=False)
                output, error = process.communicate(timeout=10)
    finally:
        if process.poll() is None:
            run(name + "-final-kill-owned-group", ["sudo", "-n", "/bin/kill", "-KILL", "--", "-" + str(process.pid)], check=False)
    (root / (name + ".log")).write_text(output + "\n[stderr]\n" + error)
    receipt = {"name": name, "timedOut": timed_out, "returncode": process.returncode,
        "elapsedSeconds": time.monotonic() - started, "timeoutSeconds": 180}
    report["commands"].append(receipt)
    checkpoint()
    return not timed_out and process.returncode == 0


def user_domain_fixture():
    fixture = {"passed": False}
    report["userDomainFixture"] = fixture
    private = root.parent / "native-trust-diagnostic-private"
    private.mkdir(mode=0o700)
    ca, leaf = root / "user-root.pem", root / "user-leaf.pem"
    (private / "root.cnf").write_text("[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=OpenClaw task user trust diagnostic\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n")
    run("user-generate-root", ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", private / "root.key", "-out", ca, "-days", "3", "-config", private / "root.cnf"])
    run("user-generate-request", ["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", private / "leaf.key", "-out", private / "leaf.csr", "-subj", "/CN=localhost"])
    (private / "ext.cnf").write_text("subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n")
    run("user-sign-leaf", ["openssl", "x509", "-req", "-in", private / "leaf.csr", "-CA", ca, "-CAkey", private / "root.key", "-CAcreateserial", "-CAserial", private / "root.srl", "-out", leaf, "-days", "3", "-extfile", private / "ext.cnf"])
    count = 0
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self):
            nonlocal count
            count += 1
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"USER_TRUST_DIAGNOSTIC_OK")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(leaf, private / "leaf.key")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    def probe(name):
        before = count
        program = "require('node:https').get(process.argv[1],r=>{r.resume();r.on('end',()=>console.log('TLS_ALLOWED'))}).on('error',e=>{console.log(e.code);process.exitCode=2})"
        tls_env = dict(env, NODE_USE_SYSTEM_CA="1")
        response = subprocess.run(["node", "-e", program, f"https://127.0.0.1:{server.server_port}"], env=tls_env, capture_output=True, text=True, timeout=20)
        (root / (name + ".log")).write_text(response.stdout + "\n[stderr]\n" + response.stderr)
        return {"returncode": response.returncode, "httpEffects": count - before, "diagnostic": response.stdout.strip()}
    keychains = shlex.split(run("user-default-keychain", ["security", "default-keychain", "-d", "user"]).stdout)
    assert len(keychains) == 1, "Task account default keychain is ambiguous"
    keychain = keychains[0]
    certificate_sha256 = hashlib.sha256(ssl.PEM_cert_to_DER_cert(ca.read_text())).hexdigest()
    fixture.update(keychain=keychain, certificateSha256=certificate_sha256)
    try:
        fixture["before"] = probe("user-node-before")
        fixture["addSucceeded"] = bounded_security("user-add-owned-trust", ["/usr/bin/security", "add-trusted-cert", "-r", "trustRoot", "-k", keychain, ca])
        run("user-export-after-add", ["security", "trust-settings-export", root / "user-trust-after-add.plist"], check=False)
        fixture["afterAdd"] = probe("user-node-after-add")
    finally:
        try:
            fixture["removeSucceeded"] = bounded_security("user-remove-owned-trust", ["/usr/bin/security", "remove-trusted-cert", ca])
            run("user-export-after-remove", ["security", "trust-settings-export", root / "user-trust-after-remove.plist"], check=False)
            fixture["afterRemove"] = probe("user-node-after-remove")
        finally:
            try:
                deleted = run("user-delete-owned-certificate", ["security", "delete-certificate", "-Z", certificate_sha256, keychain], check=False)
                fixture["certificateDeleted"] = deleted.returncode == 0
            finally:
                server.shutdown()
                server.server_close()
                checkpoint()
    fixture["passed"] = (fixture["addSucceeded"] and fixture["removeSucceeded"] and fixture["certificateDeleted"] and
        fixture["before"]["returncode"] == 2 and fixture["before"]["httpEffects"] == 0 and
        fixture["afterAdd"]["returncode"] == 0 and fixture["afterAdd"]["httpEffects"] == 1 and
        fixture["afterRemove"]["returncode"] == 2 and fixture["afterRemove"]["httpEffects"] == 0 and
        all("CERT" in fixture[x]["diagnostic"] or "VERIFY" in fixture[x]["diagnostic"] for x in ["before", "afterRemove"]))
    checkpoint()


def admin_entry_count(name):
    exported_path = root / (name + ".plist")
    exported = run(name, ["security", "trust-settings-export", "-d", exported_path], check=False)
    if exported.returncode == 0:
        return len(plistlib.loads(exported_path.read_bytes())["trustList"])
    assert "No Trust Settings were found" in exported.stderr, "Unknown admin export failure"
    return 0


def admin_domain_fixture():
    fixture = {"passed": False, "lastEntryComparison": "inconclusive"}
    report["adminDomainFixture"] = fixture
    attempted = []
    removal_attempted = set()
    try:
        fixture["baselineEntryCount"] = admin_entry_count("admin-trust-before")
        for name in ["allowed-os", "legacy-only"]:
            run(name + "-fingerprint", ["openssl", "x509", "-in", root / (name + "-root.pem"), "-noout", "-fingerprint", "-sha256"])
            attempted.append(name)
            run(name + "-add", ["sudo", "-n", "security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", root / (name + "-root.pem")])
            run(name + "-trusted-before", ["security", "verify-cert", "-c", root / (name + "-leaf.pem"), "-p", "ssl", "-n", "localhost"])
        fixture["entryCountBeforeFirstRemoval"] = admin_entry_count("admin-trust-two-owned")
        removal_attempted.add("allowed-os")
        fixture["firstRemovalSucceeded"] = bounded_security("remove-first-owned-root", ["sudo", "-n", "/usr/bin/security", "remove-trusted-cert", "-d", root / "allowed-os-root.pem"])
        fixture["entryCountAfterFirstRemoval"] = admin_entry_count("admin-trust-after-first")
        fixture["secondRemovalWasLastEntry"] = (fixture["firstRemovalSucceeded"] and fixture["entryCountAfterFirstRemoval"] == 1)
        removal_attempted.add("legacy-only")
        fixture["secondRemovalSucceeded"] = bounded_security("remove-second-owned-root", ["sudo", "-n", "/usr/bin/security", "remove-trusted-cert", "-d", root / "legacy-only-root.pem"])
        fixture["entryCountAfterSecondRemoval"] = admin_entry_count("admin-trust-after-second")
        for name in ["allowed-os", "legacy-only"]:
            checked = run(name + "-verification-after-removal", ["security", "verify-cert", "-c", root / (name + "-leaf.pem"), "-p", "ssl", "-n", "localhost"], check=False)
            fixture[name + "TrustedAfterRemoval"] = checked.returncode == 0
        fixture["passed"] = (fixture["firstRemovalSucceeded"] and fixture["secondRemovalSucceeded"] and
            not fixture["allowed-osTrustedAfterRemoval"] and not fixture["legacy-onlyTrustedAfterRemoval"] and
            fixture["entryCountAfterSecondRemoval"] == fixture["baselineEntryCount"])
        if fixture["secondRemovalWasLastEntry"] and fixture["entryCountBeforeFirstRemoval"] == 2:
            fixture["lastEntryComparison"] = "observed"
    except Exception as error:
        fixture["failure"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        # Setup/export failures must not prevent owned cleanup or the user-domain sibling.
        for name in attempted:
            if name in removal_attempted:
                continue
            try:
                fixture[name + "RecoveryRemovalSucceeded"] = bounded_security(name + "-recovery-remove", ["sudo", "-n", "/usr/bin/security", "remove-trusted-cert", "-d", root / (name + "-root.pem")])
            except Exception as error:
                fixture[name + "RecoveryFailure"] = {"type": type(error).__name__, "message": str(error)}
        checkpoint()


try:
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == "92a233c58e1793333a0fc01ca3f275f89a50885c46ad7f69d6292d5396859cbb"
    with zipfile.ZipFile(archive) as packed:
        for name in ["allowed-os-root.pem", "allowed-os-leaf.pem", "legacy-only-root.pem", "legacy-only-leaf.pem"]:
            data = packed.read("native-service-trust-proof/evidence/" + name)
            (root / name).write_bytes(data)
    report["sourceEvidenceArtifactId"] = 12588402630
    report["sourceEvidenceZipSha256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
    run("native-os", ["sw_vers"])
    run("sip-status", ["csrutil", "status"])
    run("gui-domain", ["launchctl", "print", f"gui/{os.getuid()}"])
    admin_domain_fixture()
    run("node-runtime", ["node", "--version"])
    try:
        user_domain_fixture()
    except Exception as error:
        fixture = report.setdefault("userDomainFixture", {"passed": False})
        fixture["failure"] = {"type": type(error).__name__, "message": str(error)}
    passed = report["adminDomainFixture"]["passed"] and report["userDomainFixture"]["passed"]
    report["status"] = "diagnostic-complete-cleanup-passed" if passed else "diagnostic-complete-cleanup-failed"
    checkpoint()
    assert passed, "Owned trust cleanup failed; inspect separate admin/user outcomes"
except Exception as error:
    if report["status"] == "running":
        report["status"] = "diagnostic-failed"
    report["failure"] = {"type": type(error).__name__, "message": str(error)}
    raise
finally:
    checkpoint()
    manifest = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir() if p.is_file()}
    (root / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
