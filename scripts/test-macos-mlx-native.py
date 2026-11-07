#!/usr/bin/env python3
"""Disposable org-CI proof for the real MLX helper; never uses an operator profile."""

import argparse
import base64
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid


STABLE = "8b18b5578f66eab1501cba4cef2310d88bfb9a41"  # v2026.10.9, not a moving release.
BAD = "6d3c68afc27ba52972a76deb2cee0e483d6e1b4f"
BAD_MANIFEST_SHA256 = "2164677fc1096873f7130346d5b595945261cf688104deaa608c02a1d2c762cf"
BAD_LOCK_SHA256 = "0be43dc0d1edf2f7ab547c5c5ed7f99ce4f9976e5b2e87a83494c6f6383af0a0"
BAD_RESOLUTION = "test/fixtures/macos-mlx-native/bad.Package.resolved"
BAD_RESOLUTION_SHA256 = "ed4fbe6da8823c6f5739d495df9912b40dca9670a96ae1089c62b29d8a85ca03"
MODEL = "mlx-community/Soprano-80M-bf16"
REVISION = "b7da048eff3dfd556409a44b78b9c61a9dd4ccfa"
FILES = {
    "config.json": (680, "cfaff3fd177b291ecc244a181dceaa2168ef373a"),
    "model.safetensors": (217333883, "95e42d42bc879213d49d940e0884024eb153fb6daccf2229864cca0fbbbb268a"),
    "model.safetensors.index.json": (20898, "339bb569f743d59229c4efa7191b57b6e8d9d93d"),
    "special_tokens_map.json": (158, "c17f7dea55ee6007de7886fc804602a15bcefe44"),
    "tokenizer.json": (1792331, "6b6ffca6f6732bd67cfeb7a6de883884d5ecc054"),
    "tokenizer_config.json": (1494887, "aa19994c965569c529847a4c6c92e07f1eae0fe7"),
}
PACKAGE = "apps/macos-mlx-tts"
PROTOCOL = "apps/shared/OpenClawMLXTTSProtocol"
INPUTS = [
    f"{PACKAGE}/Package.swift",
    f"{PACKAGE}/Package.resolved",
    f"{PACKAGE}/Sources/OpenClawMLXTTSHelper/main.swift",
    f"{PACKAGE}/Sources/OpenClawMLXTTSRuntime/MLXTTSHelperService.swift",
    f"{PROTOCOL}/Sources/OpenClawMLXTTSProtocol/MLXTTSProtocol.swift",
]
TEXT = "The quiet fox waits beside the river."
ACTIVE_TEXT = (
    "Along the quiet river, the patient fox watches the evening light settle over the stones and waits for the wind. "
    "The path behind the old bridge stays empty while distant birds circle above the forest and the water moves below."
)
FRAME_LIMIT = 64 * 1024 * 1024  # The shared Swift frame codec's public limit.
PCM_LIMIT = 16 * 1024 * 1024
CACHE_LIMIT = 2 * 1024 * 1024 * 1024  # Includes Hub duplication and both legacy fixtures.
CAPTURE_LIMIT = 64 * 1024
CONFIG_URL = f"https://huggingface.co/{MODEL}/resolve/{REVISION}/config.json"
FOUNDATION_SOURCE = r'''import CryptoKit
import Darwin
import Foundation

func darwinTemporaryDirectory() -> (state: String, url: URL?) {
    let count = confstr(_CS_DARWIN_USER_TEMP_DIR, nil, 0)
    guard count > 1, count <= 4096 else { return ("query-invalid", nil) }
    var buffer = [CChar](repeating: 0, count: count)
    guard confstr(_CS_DARWIN_USER_TEMP_DIR, &buffer, count) == count else { return ("copy-length-mismatch", nil) }
    return ("available", URL(fileURLWithPath: String(cString: buffer), isDirectory: true))
}

// Keep Foundation's default auth/cache configuration and HF's delegate/task/move shape.
final class Probe: NSObject, URLSessionDownloadDelegate, URLSessionDataDelegate, @unchecked Sendable {
    let mode: String
    let root: URL
    let platformTemporary: URL
    let destination: URL
    let done = DispatchSemaphore(value: 0)
    var bytes = Data()
    var failure: String?
    var result: [String: Any]
    var redirects = 0
    var session: URLSession!

    init(mode: String, root: URL, platformTemporary: URL, destination: URL) {
        self.mode = mode
        self.root = root.resolvingSymlinksInPath()
        self.platformTemporary = platformTemporary.resolvingSymlinksInPath()
        // Resolve only the existing parent, preserving the parent's unique, nonexistent leaf.
        // Foundation can normalize that directory differently from the supplied path.
        let destinationParent = destination.deletingLastPathComponent().resolvingSymlinksInPath()
        self.destination = destinationParent.appendingPathComponent(destination.lastPathComponent, isDirectory: false)
        self.result = ["mode": mode, "pid": Int(getpid()), "ok": false, "moved": false]
        super.init()
        result["homeRelation"] = relation(URL(fileURLWithPath: NSHomeDirectory()))
        result["temporaryRelation"] = relation(FileManager.default.temporaryDirectory)
    }

    func relation(_ url: URL) -> String {
        let path = url.resolvingSymlinksInPath().path
        if path == root.path || path.hasPrefix(root.path + "/") { return "owned" }
        if path == platformTemporary.path || path.hasPrefix(platformTemporary.path + "/") { return "platform-temp" }
        return "outside-owned"
    }

    func allowed(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host == "huggingface.co",
              parts.user == nil, parts.password == nil, parts.port == nil || parts.port == 443 else { return false }
        return [
            "/mlx-community/Soprano-80M-bf16/resolve/b7da048eff3dfd556409a44b78b9c61a9dd4ccfa/config.json",
            "/api/resolve-cache/models/mlx-community/Soprano-80M-bf16/b7da048eff3dfd556409a44b78b9c61a9dd4ccfa/config.json"
        ].contains(parts.path)
    }

    func responseOK(_ response: URLResponse?) -> Bool {
        guard let response = response as? HTTPURLResponse, let url = response.url, allowed(url) else {
            failure = "response-identity"
            return false
        }
        result["status"] = response.statusCode
        var publicURL = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        publicURL.query = nil
        publicURL.fragment = nil
        result["url"] = publicURL.string!
        guard response.statusCode == 200, response.expectedContentLength <= 680 else {
            failure = "response-status-or-length"
            return false
        }
        return true
    }

    func identity(_ data: Data) -> Bool {
        guard data.count == 680 else { failure = "accepted-length"; return false }
        var blob = Data("blob 680\0".utf8)
        blob.append(data)
        let hash = Insecure.SHA1.hash(data: blob).map { String(format: "%02x", $0) }.joined()
        result["acceptedBytes"] = data.count
        result["gitBlob"] = hash
        guard hash == "cfaff3fd177b291ecc244a181dceaa2168ef373a" else {
            failure = "accepted-identity"
            return false
        }
        return true
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        redirects += 1
        guard redirects <= 3, let url = request.url, allowed(url) else {
            failure = "redirect-identity-or-limit"
            completionHandler(nil)
            task.cancel()
            return
        }
        completionHandler(request)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        completionHandler(responseOK(response) ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        // Bound retained data before append; cancellation cannot cap bytes already in flight.
        guard data.count <= 680 - bytes.count else {
            failure = "retained-byte-limit"
            dataTask.cancel()
            return
        }
        bytes.append(data)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard responseOK(downloadTask.response), totalBytesWritten <= 680, totalBytesExpectedToWrite <= 680 else {
            if failure == nil { failure = "download-progress-limit" }
            downloadTask.cancel()
            return
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        result["callbackRelation"] = relation(location)
        guard failure == nil, responseOK(downloadTask.response) else { return }
        do {
            guard ["owned", "platform-temp"].contains(relation(location)) else {
                failure = "callback-outside-admitted-staging"
                return
            }
            let attributes = try FileManager.default.attributesOfItem(atPath: location.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == geteuid(),
                  (attributes[.size] as? NSNumber)?.intValue == 680 else {
                failure = "callback-file-size-or-type"
                return
            }
            guard identity(try Data(contentsOf: location)) else { return }
            // HF moves the framework location into Foundation TEMP; TMPDIR may not redirect it.
            // The parent knows this one destination before spawn and retires only it.
            let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            guard temporary == platformTemporary,
                  destination.deletingLastPathComponent() == temporary,
                  !FileManager.default.fileExists(atPath: destination.path) else {
                failure = "unowned-hf-destination"
                return
            }
            try FileManager.default.moveItem(at: location, to: destination)
            result["moved"] = true
        } catch {
            failure = "callback-move-or-read"
            result["errors"] = errors(error as NSError)
        }
    }

    func errors(_ error: NSError, depth: Int = 0) -> [[String: Any]] {
        let domain = error.domain.range(of: "^[A-Za-z0-9_.-]{1,80}$", options: .regularExpression) == nil ? "other" : error.domain
        var chain: [[String: Any]] = [["domain": domain, "code": error.code]]
        if depth < 2, let nested = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            chain += errors(nested, depth: depth + 1)
        }
        return chain
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            if failure == nil { failure = "native-task" }
            if result["errors"] == nil { result["errors"] = errors(error as NSError) }
        }
        if mode == "data", failure == nil { _ = identity(bytes) }
        if mode == "download", failure == nil, result["moved"] as? Bool != true { failure = "missing-download-callback" }
        result["ok"] = failure == nil
        result["failure"] = failure
        result["redirects"] = redirects
        done.signal()
    }

    func run(_ url: URL) -> Int32 {
        let native = darwinTemporaryDirectory()
        let nativeResolved = native.url?.resolvingSymlinksInPath()
        let foundationResolved = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
        let destinationParent = destination.deletingLastPathComponent()
        let nativeURLMatches = nativeResolved.map { $0 == platformTemporary }
        let foundationURLMatches = foundationResolved == platformTemporary
        let destinationParentURLMatches = destinationParent == platformTemporary
        let firstFailed: String? = nativeResolved == nil ? "native-lookup" :
            nativeURLMatches != true ? "native-url" :
            !foundationURLMatches ? "foundation-url" :
            !destinationParentURLMatches ? "destination-parent-url" : nil
        // Record the guard's own operands without exporting private path representations.
        result["preflight"] = [
            "nativeLookup": native.state,
            "nativeURLMatches": nativeURLMatches.map { $0 as Any } ?? NSNull(),
            "foundationURLMatches": foundationURLMatches,
            "destinationParentURLMatches": destinationParentURLMatches,
            "nativePathMatches": nativeResolved.map { ($0.path == platformTemporary.path) as Any } ?? NSNull(),
            "foundationPathMatches": foundationResolved.path == platformTemporary.path,
            "destinationParentPathMatches": destinationParent.path == platformTemporary.path,
            "nativeHasDirectoryPath": nativeResolved.map { $0.hasDirectoryPath as Any } ?? NSNull(),
            "foundationHasDirectoryPath": foundationResolved.hasDirectoryPath,
            "platformHasDirectoryPath": platformTemporary.hasDirectoryPath,
            "destinationParentHasDirectoryPath": destinationParent.hasDirectoryPath,
            "firstFailed": firstFailed.map { $0 as Any } ?? NSNull(),
        ]
        guard let nativeTemporary = nativeResolved,
              nativeTemporary == platformTemporary,
              foundationResolved == platformTemporary,
              destinationParent == platformTemporary else {
            result["failure"] = "platform-temp-preflight"
            emit(result)
            return 1
        }
        result["platformTemporaryAgreement"] = true
        let original = URLSession(configuration: .default)
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: original.configuration, delegate: self, delegateQueue: queue)
        original.finishTasksAndInvalidate()
        let task: URLSessionTask = mode == "download" ? session.downloadTask(with: url) : session.dataTask(with: url)
        task.resume()
        guard done.wait(timeout: .now() + 25) == .success else {
            task.cancel()
            session.invalidateAndCancel()
            emit(["mode": mode, "pid": Int(getpid()), "ok": false, "failure": "task-deadline"])
            return 1
        }
        session.finishTasksAndInvalidate()
        emit(result)
        return result["ok"] as? Bool == true ? 0 : 1
    }
}

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data.count <= 4096 else { exit(2) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

let arguments = CommandLine.arguments
if arguments.count == 4, arguments[1] == "platform-temp" {
    guard let temporary = darwinTemporaryDirectory().url,
          temporary.resolvingSymlinksInPath() == FileManager.default.temporaryDirectory.resolvingSymlinksInPath() else {
        emit(["mode": "platform-temp", "pid": Int(getpid()), "ok": false])
        exit(1)
    }
    // Quiet internal receipt only; the parent must never publish this private path.
    emit(["mode": "platform-temp", "pid": Int(getpid()), "ok": true, "temporary": temporary.path])
    exit(0)
}
guard arguments.count == 6, ["download", "data"].contains(arguments[1]),
      let url = URL(string: arguments[3]) else { exit(2) }
let probe = Probe(mode: arguments[1], root: URL(fileURLWithPath: arguments[2]),
                  platformTemporary: URL(fileURLWithPath: arguments[4], isDirectory: true),
                  destination: URL(fileURLWithPath: arguments[5]))
guard probe.allowed(url) else { exit(2) }
exit(probe.run(url))
'''
METAL_SOURCE = r'''import Darwin
import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else {
    print("MLX Metal device: unavailable; library not loaded")
    exit(CommandLine.arguments[2] == "required" ? 1 : 0)
}
print("MLX Metal device: \(device.name)")
do {
    _ = try device.makeLibrary(URL: URL(fileURLWithPath: CommandLine.arguments[1]))
    print("MLX Metal library: available")
} catch {
    print("MLX Metal library: unavailable (\(error))")
    exit(1)
}
'''


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def require_hosted_ci():
    require(sys.platform == "darwin" and os.environ.get("GITHUB_ACTIONS") == "true" and
            os.environ.get("GITHUB_REPOSITORY") == "openclaw/openclaw" and
            os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and
            os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted",
            "platform staging requires admitted canonical manual github-hosted macOS CI")


def validate_platform_temp(path):
    try:
        path = Path(path)
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode), "platform temp is not a regular directory")
        canonical = path.resolve(strict=True)
        current = canonical.lstat()
        require((current.st_dev, current.st_ino) == (info.st_dev, info.st_ino), "platform temp changed during validation")
        info = current
    except (OSError, ValueError, RuntimeError):
        raise RuntimeError("platform temp directory metadata unavailable or invalid") from None
    require(re.fullmatch(r"/private/var/folders/[^/]+/[^/]+/T", str(canonical)), "platform temp is not an exact Darwin user T directory")
    require(os.geteuid() != 0 and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
            "platform temp ownership or mode is not admitted")
    return canonical


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def frame(value):
    body = json.dumps(value, separators=(",", ":")).encode()
    require(0 < len(body) <= FRAME_LIMIT, "invalid request frame length")
    return struct.pack(">I", len(body)) + body


def decode_frames(buffer):
    result = []
    while len(buffer) >= 4:
        length = struct.unpack(">I", buffer[:4])[0]
        require(0 < length <= FRAME_LIMIT, "invalid helper frame length")
        if len(buffer) < 4 + length:
            break
        value = json.loads(buffer[4:4 + length])
        require(isinstance(value, dict), "helper frame is not an object")
        result.append(value)
        del buffer[:4 + length]
    return result


def denied_cache_error(event):
    error = event.get("error", {})
    require(event.get("type") == "error" and error.get("id") == "bad-offline" and error.get("code") == "model_load_failed", "bad variant did not fail at model load")
    # A file permission or GPU failure is not the expected network/cache red.
    require(re.search(r"NSURLError|networkError|network connection|internet connection|Network is unreachable|Could not resolve host|DNS", error.get("message", ""), re.I), "bad load error does not identify denied-network path")
    return error


class Budget:
    def __init__(self, started):
        require(0 <= time.monotonic() - started < 27 * 60, "unknown or exhausted native job budget")
        self.work_end = started + 27 * 60
        self.cleanup_end = started + 30 * 60

    def deadline(self, seconds):
        require(time.monotonic() < self.work_end, "native proof work budget exhausted")
        return min(self.work_end, time.monotonic() + seconds)


class CaptureCustodyError(RuntimeError):
    """Diagnostic availability must never hide uncertain process or file custody."""


class Child:
    """Own one process group and all three pipes, including on deadline failure."""

    def __init__(self, argv, cwd, env, framed=False, quiet_limit=None, owner=None):
        require(quiet_limit is None or (not framed and 0 < quiet_limit <= CAPTURE_LIMIT), "invalid quiet capture bound")
        self.selector = selectors.DefaultSelector()
        self.ready = False
        self.framed = framed
        self.buffer = bytearray()
        self.events = []
        self.stdout = bytearray()
        self.stderr = bytearray()
        self.stderr_bytes = 0
        self.stderr_hash = hashlib.sha256()
        self.on_tick = None
        self.discard = False
        self.quiet_limit = quiet_limit
        self.capture_overflow = False
        self.captured_bytes = 0
        try:
            self.process = subprocess.Popen(
                [str(x) for x in argv], cwd=cwd, env=env, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True, start_new_session=True,
            )
        except BaseException:
            self.selector.close()
            raise
        self.group = self.process.pid
        if owner is not None:
            owner.append(self)  # Record actual spawn before fallible descriptor setup.
        for pipe, name in [(self.process.stdout, "stdout"), (self.process.stderr, "stderr")]:
            os.set_blocking(pipe.fileno(), False)
            self.selector.register(pipe, selectors.EVENT_READ, name)
        os.set_blocking(self.process.stdin.fileno(), False)
        self.ready = True

    def pump(self, deadline):
        require(time.monotonic() < deadline, "child phase deadline exhausted")
        if self.on_tick:
            self.on_tick()
        for key, _ in self.selector.select(min(0.1, max(0, deadline - time.monotonic()))):
            data = os.read(key.fileobj.fileno(), 65536)
            if not data:
                self.selector.unregister(key.fileobj)
                key.fileobj.close()
                continue
            if key.data == "stderr":
                self.stderr_bytes += len(data)
                self.stderr_hash.update(data)
            if self.discard:
                continue
            if self.quiet_limit is not None:
                # Never echo raw diagnostics, including unsolicited Foundation stderr.
                remaining = max(0, self.quiet_limit - self.captured_bytes)
                self.capture_overflow |= len(data) > remaining
                target = self.stdout if key.data == "stdout" else self.stderr
                target.extend(data[:remaining])
                self.captured_bytes += min(len(data), remaining)
                continue
            if key.data == "stdout" and self.framed:
                self.buffer.extend(data)
                self.events.extend(decode_frames(self.buffer))
                require(len(self.events) <= 256, "helper event queue exceeded its bound")
            else:
                target = self.stdout if key.data == "stdout" else self.stderr
                target.extend(data)
                del target[:-65536]
                if not self.framed:
                    stream = sys.stdout.buffer if key.data == "stdout" else sys.stderr.buffer
                    stream.write(data)
                    stream.flush()

    def send(self, value, deadline):
        data = memoryview(frame(value))
        while data:
            require(time.monotonic() < deadline, "helper stdin deadline exhausted")
            try:
                data = data[os.write(self.process.stdin.fileno(), data):]
            except BlockingIOError:
                self.pump(deadline)

    def event(self, deadline):
        while not self.events:
            require(self.selector.get_map(), "helper exited before its terminal event: " + self.stderr.decode(errors="replace"))
            self.pump(deadline)
        return self.events.pop(0)

    def group_exists(self):
        try:
            os.killpg(self.group, 0)
            return True
        except ProcessLookupError:
            return False

    def joined(self):
        return self.process.poll() is not None and not self.selector.get_map() and not self.group_exists() and (self.ready or all(pipe.closed for pipe in [self.process.stdout, self.process.stderr]))

    def join(self, deadline):
        while not self.joined():
            self.pump(deadline)
        require(not self.buffer and not self.events, "unconsumed helper output at process retirement")
        return self.process.returncode

    def retire(self, cleanup_end):
        # A failed decoder/cache assertion must not prevent process-tree cleanup.
        self.on_tick = None
        self.discard = True
        self.process.stdin.close()
        if not self.ready:
            # A failed constructor may have registered only some pipes. Retire the
            # known group first, then close every owned endpoint without decoding.
            for sig, seconds in [(signal.SIGTERM, 10), (signal.SIGKILL, 5)]:
                if self.group_exists():
                    os.killpg(self.group, sig)
                deadline = min(cleanup_end, time.monotonic() + seconds)
                while time.monotonic() < deadline and (self.process.poll() is None or self.group_exists()):
                    time.sleep(0.01)
            require(self.process.poll() is not None and not self.group_exists(), "partially initialized child group could not retire")
            for pipe in [self.process.stdout, self.process.stderr]:
                pipe.close()
            self.selector.close()
            return
        for sig, seconds in [(None, 15), (signal.SIGTERM, 10), (signal.SIGKILL, 5)]:
            if self.joined():
                break
            if sig is not None and self.group_exists():
                os.killpg(self.group, sig)
            deadline = min(cleanup_end, time.monotonic() + seconds)
            while time.monotonic() < deadline and not self.joined():
                try:
                    self.pump(deadline)
                except RuntimeError:
                    if time.monotonic() < deadline:
                        raise
        self.process.poll()
        require(self.joined(), "owned process group or pipes could not be retired; retaining scratch")
        self.selector.close()


def sandbox_denials(raw, pid, started, ended, roots):
    """Allowlist one retired child's bounded log window; raw messages never escape."""
    require(0 < pid and started <= ended and len(raw) <= CAPTURE_LIMIT, "invalid denial capture")
    records = []
    finished = False
    for line in raw.splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        require(isinstance(event, dict), "invalid denial event")
        require(not finished, "event after denial completion record")
        if "finished" in event:
            finished = True
            continue
        timestamp = datetime.fromisoformat(event["timestamp"])
        require(timestamp.tzinfo is not None, "denial timestamp has no timezone")
        stamp = timestamp.timestamp()
        match = re.fullmatch(r"Sandbox: [^\s()]{1,128}\((\d+)\) deny\(\d+\) ([a-z][a-z0-9*-]{0,63})(?: (.*))?", event.get("eventMessage", ""))
        if not match or int(match[1]) != pid or not started <= stamp <= ended:
            continue
        operation, argument = match[2], match[3] or ""
        allowed = {"mach-lookup", "file-read-data", "file-read-metadata", "file-write-create", "file-write-data", "file-write-mode", "file-write-unlink", "network-outbound", "network-inbound", "network-bind", "system-socket", "ipc-posix-shm-read-data"}
        record = {"pid": pid, "operation": operation if operation in allowed else "other", "resourceState": "available" if operation in allowed else "unavailable"}
        if operation == "mach-lookup" and re.fullmatch(r"com\.apple\.[A-Za-z0-9_.-]{1,140}", argument):
            record["systemService"] = argument
        elif argument.startswith("/"):
            # Classify text only: do not stat/read paths named by system diagnostics.
            path = os.path.normpath(argument)
            relation = next((label for label, root in roots.items() if path == str(root) or path.startswith(str(root) + "/")), None)
            if relation is None:
                darwin = re.match(r"^/(?:private/)?var/folders/[^/]+/[^/]+/(T|C)(?:/|$)", path)
                if darwin:
                    relation = "darwin-user-temp" if darwin[1] == "T" else "darwin-user-cache"
                elif path == "/Library/Keychains" or path.startswith("/Library/Keychains/"):
                    relation = "system-keychain"
            record["pathRelation"] = relation or "outside-known-roots"
            if relation is None:
                record["resourceState"] = "unavailable"
        else:
            record["resource"] = "redacted-or-unclassified"
            record["resourceState"] = "unavailable"
        records.append(record)
        require(len(records) <= 16 and len(json.dumps(records).encode()) <= 16 * 1024, "normalized denial capture overflow")
    require(finished, "denial capture lacks completion record")
    return records


def foundation_record(raw, pid, mode):
    require(0 < len(raw) <= 4096, "invalid Foundation receipt size")
    value = json.loads(raw)
    require(isinstance(value, dict) and value.get("pid") == pid and value.get("mode") == mode and type(value.get("ok")) is bool, "invalid Foundation receipt identity")
    allowed = {"mode", "pid", "ok", "moved", "homeRelation", "temporaryRelation", "callbackRelation", "platformTemporaryAgreement", "status", "url", "acceptedBytes", "gitBlob", "failure", "redirects", "errors", "preflight"}
    require(value.keys() <= allowed, "unexpected Foundation receipt field")
    for key in ["homeRelation", "temporaryRelation", "callbackRelation"]:
        require(key not in value or value[key] in ["owned", "platform-temp", "outside-owned"], "invalid Foundation path relation")
    require("platformTemporaryAgreement" not in value or type(value["platformTemporaryAgreement"]) is bool, "invalid platform temp agreement")
    failures = {"response-identity", "response-status-or-length", "accepted-length", "accepted-identity", "redirect-identity-or-limit", "retained-byte-limit", "download-progress-limit", "callback-file-size-or-type", "callback-outside-admitted-staging", "platform-temp-preflight", "unowned-hf-destination", "callback-move-or-read", "native-task", "missing-download-callback", "task-deadline"}
    require(value.get("failure") is None or value["failure"] in failures, "invalid Foundation failure class")
    preflight = value.get("preflight")
    require(value.get("failure") != "platform-temp-preflight" or preflight is not None, "missing Foundation preflight facts")
    if preflight is not None:
        native_fields = {"nativeURLMatches", "nativePathMatches", "nativeHasDirectoryPath"}
        bool_fields = {"foundationURLMatches", "destinationParentURLMatches", "foundationPathMatches", "destinationParentPathMatches", "foundationHasDirectoryPath", "platformHasDirectoryPath", "destinationParentHasDirectoryPath"}
        require(isinstance(preflight, dict) and preflight.keys() == native_fields | bool_fields | {"nativeLookup", "firstFailed"}, "invalid Foundation preflight fields")
        require(preflight["nativeLookup"] in ["query-invalid", "copy-length-mismatch", "available"], "invalid Foundation native lookup state")
        available = preflight["nativeLookup"] == "available"
        require(all(type(preflight[key]) is bool for key in bool_fields) and
                all(type(preflight[key]) is bool if available else preflight[key] is None for key in native_fields), "invalid Foundation preflight types")
        for owner in ["native", "foundation", "destinationParent"]:
            require(preflight[owner + "URLMatches"] is not True or preflight[owner + "PathMatches"] is True, "inconsistent Foundation preflight equality")
        first_failed = ("native-lookup" if not available else "native-url" if not preflight["nativeURLMatches"] else
                        "foundation-url" if not preflight["foundationURLMatches"] else
                        "destination-parent-url" if not preflight["destinationParentURLMatches"] else None)
        require(preflight["firstFailed"] == first_failed, "invalid Foundation first failed predicate")
        require((value.get("failure") == "platform-temp-preflight") == (first_failed is not None), "inconsistent Foundation preflight failure")
        require(first_failed is None or (not value["ok"] and value.get("moved") is False and value.get("platformTemporaryAgreement") is not True), "false Foundation preflight success")
    for key in ["status", "acceptedBytes", "redirects"]:
        require(key not in value or (type(value[key]) is int and 0 <= value[key] <= (599 if key == "status" else 680 if key == "acceptedBytes" else 3)), "invalid Foundation numeric field")
    require("moved" not in value or type(value["moved"]) is bool, "invalid callback move receipt")
    require("gitBlob" not in value or re.fullmatch(r"[0-9a-f]{40}", value["gitBlob"]), "invalid Foundation blob")
    urls = [CONFIG_URL, f"https://huggingface.co/api/resolve-cache/models/{MODEL}/{REVISION}/config.json"]
    require("url" not in value or value["url"] in urls, "invalid Foundation public URL")
    errors = value.get("errors", [])
    require(isinstance(errors, list) and len(errors) <= 3, "invalid Foundation error chain")
    for error in errors:
        require(isinstance(error, dict) and error.keys() == {"domain", "code"} and isinstance(error["domain"], str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", error["domain"]) and type(error["code"]) is int, "invalid Foundation error metadata")
    if value["ok"]:
        require(value.get("platformTemporaryAgreement") is True, "Foundation temp was not admitted before request")
        require(value.get("status") == 200 and value.get("acceptedBytes") == 680 and value.get("gitBlob") == FILES["config.json"][1] and value.get("failure") is None and value.get("url") in urls, "incomplete Foundation success")
        require(mode != "download" or value.get("moved") is True, "missing Foundation callback move")
    return value


class Proof:
    def __init__(self, checkout, scratch, proof_dir, budget):
        self.checkout, self.scratch, self.proof_dir, self.budget = checkout, scratch, proof_dir, budget
        self.children = []
        self.platform_temp = None
        self.platform_destinations = []
        self.result = {
            "version": 1, "phases": [], "variants": {}, "requests": [], "complete": False,
            "generation": {"text": TEXT, "activeText": ACTIVE_TEXT, "defaultMaxTokensPerSentence": 1200, "parameterOverrides": False},
        }
        self.phase = "initialization"
        self.cache_root = scratch / "model-caches"
        self.cache_root.mkdir()
        self.env = {key: os.environ[key] for key in ["HOME", "PATH", "DEVELOPER_DIR", "SDKROOT", "TOOLCHAINS", "LANG", "LC_ALL"] if key in os.environ}
        self.env.update({"CI": "true", "GIT_NO_LAZY_FETCH": "1", "GIT_NO_REPLACE_OBJECTS": "1"})

    def begin(self, name):
        self.phase = name
        self.result["phases"].append({"name": name, "started": time.monotonic()})
        print(f"[mlx-native] {name}", flush=True)

    def command(self, argv, seconds, cwd=None, env=None):
        child = Child(argv, cwd or self.checkout, env or self.env, owner=self.children)
        try:
            code = child.join(self.budget.deadline(seconds))
            require(code == 0, f"{self.phase}: command failed (exit {code}): {child.stderr.decode(errors='replace')}")
            return child.stdout.decode().strip()
        finally:
            child.retire(self.budget.cleanup_end)

    def quiet_capture(self, argv, seconds, env=None):
        started = time.time()
        previous = len(self.children)
        try:
            child = Child(argv, self.checkout, env or self.env, quiet_limit=CAPTURE_LIMIT, owner=self.children)
        except BaseException:
            for spawned in self.children[previous:]:
                try:
                    spawned.retire(self.budget.cleanup_end)
                except (RuntimeError, OSError):
                    self.result["captureCustodyFailed"] = True
            raise
        code, failure = None, None
        try:
            code = child.join(self.budget.deadline(seconds))
        except RuntimeError:
            failure = "capture-deadline"
        finally:
            try:
                child.retire(self.budget.cleanup_end)
            except (RuntimeError, OSError):
                self.result["captureCustodyFailed"] = True
                raise CaptureCustodyError("quiet diagnostic child retirement unverified; retaining scratch") from None
        return {"child": child, "code": code, "failure": failure, "started": started, "ended": time.time()}

    def denial_receipt(self, capture):
        child, started, ended = capture["child"], capture["started"], capture["ended"]
        pid = child.process.pid
        predicate = ('(((processID == 0) AND (senderImagePath CONTAINS "/Sandbox")) OR '
                     '(subsystem == "com.apple.sandbox.reporting")) AND '
                     f'(eventMessage CONTAINS "Sandbox:") AND (eventMessage CONTAINS "({pid})")')
        try:
            require(child.joined(), "denial observation requires a retired child")
            output = self.quiet_capture(["/usr/bin/log", "show", "--style", "ndjson", "--timezone", "UTC", "--start", f"@{started:.6f}", "--end", f"@{ended:.6f}", "--predicate", predicate], 10)
            log_child = output["child"]
            require(output["code"] == 0 and not log_child.capture_overflow and not output["failure"], "denial log capture unavailable")
            roots = {**capture.get("roots", {}), "owned-scratch": self.scratch, "checkout": self.checkout, "runner-home": Path(os.environ["HOME"])}
            records = sandbox_denials(bytes(log_child.stdout), pid, started, ended, roots)
            observed = records and all(record["resourceState"] == "available" for record in records)
            return {"state": "observed" if observed else "unavailable", "records": records}
        except CaptureCustodyError:
            raise
        except (RuntimeError, ValueError, TypeError, KeyError, OSError):
            return {"state": "unavailable", "records": []}

    def admit_platform_temp(self, binary):
        require_hosted_ci()  # Protected runner receipt precedes directory discovery and any grant.
        home = self.scratch / "foundation-directory-home"
        capture = self.quiet_capture([binary, "platform-temp", self.scratch, CONFIG_URL], 10,
                                     env=self.isolated_env(home, home / "hf-hub"))
        child = capture["child"]
        require(capture["code"] == 0 and not capture["failure"] and not child.capture_overflow and child.joined(),
                "native platform temp discovery unavailable")
        value = json.loads(bytes(child.stdout))
        require(isinstance(value, dict) and value.keys() == {"mode", "pid", "ok", "temporary"} and value["mode"] == "platform-temp" and
                value["pid"] == child.process.pid and value["ok"] is True and isinstance(value["temporary"], str),
                "native platform temp discovery identity mismatch")
        self.platform_temp = validate_platform_temp(value["temporary"])
        self.result["platformStaging"] = {
            "runnerEnvironment": os.environ["RUNNER_ENVIRONMENT"], "event": "workflow_dispatch",
            "repository": "openclaw/openclaw", "category": "platform-temp", "ownerMode": "0700",
            "hostBasis": "protected github-hosted receipt; disposable per-job VM/account",
            "ownerMatchesRunner": True, "exclusiveTaskDirectory": False, "aclIsolationProven": False,
            "frameworkResiduals": "not enumerated or removed; retired with the documented job VM",
        }

    def cleanup_foundation_destination(self, pending, child, expected_created):
        try:
            require(child.joined(), "platform destination cleanup requires retired child")
            path = pending["path"]
            try:
                before = path.lstat()
            except FileNotFoundError:
                require(not expected_created, "created platform destination disappeared")
                pending["retired"] = True
                return "not-created"
            require(stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid() and before.st_size == 680 and before.st_nlink == 1,
                    "platform destination type, ownership or size mismatch")
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as source:
                opened = os.fstat(source.fileno())
                require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), "platform destination changed before verification")
                data = source.read(681)
            require(len(data) == 680 and hashlib.sha1(b"blob 680\0" + data).hexdigest() == FILES["config.json"][1], "platform destination identity mismatch")
            current = path.lstat()
            require((current.st_dev, current.st_ino) == (before.st_dev, before.st_ino), "platform destination changed before unlink")
            path.unlink()  # Only the one parent-selected, identity-verified callback destination.
            pending["retired"] = True
            return "removed-verified-file"
        except (RuntimeError, OSError):
            self.result["platformCleanupFailed"] = True
            raise CaptureCustodyError("platform destination custody unverified; retaining scratch") from None

    def foundation_attempt(self, binary, mode):
        require_hosted_ci()
        home = self.scratch / ("foundation-" + mode + "-home")
        env = self.isolated_env(home, home / "hf-hub")
        require(self.platform_temp is not None, "platform temp has not been admitted")
        destination = self.platform_temp / ("hf-download-" + str(uuid.uuid4()) + ".tmp")
        require(not destination.exists() and not destination.is_symlink(), "intended platform destination already exists")
        argv = self.sandbox([binary, mode, self.scratch, CONFIG_URL, self.platform_temp, destination], online=True)
        pending = {"path": destination, "retired": False}
        self.platform_destinations.append(pending)
        previous = len(self.children)
        try:
            capture = self.quiet_capture(argv, 30, env=env)
        except BaseException as error:
            record = {"mode": mode, "ok": False, "failure": "receipt-unavailable", "initialCaptureFailure": type(error).__name__, "destinationCleanup": "unverified"}
            self.result.setdefault("foundationAdmission", {})["primary" if mode == "download" else "secondary"] = record
            try:
                spawned = self.children[previous:]
                if spawned:
                    require(all(child.joined() for child in spawned), "capture child custody unverified")
                    record["destinationCleanup"] = self.cleanup_foundation_destination(pending, spawned[-1], False)
                else:
                    try:
                        destination.lstat()
                    except FileNotFoundError:
                        pending["retired"] = True
                        record["destinationCleanup"] = "no-child-no-file"
                    require(pending["retired"], "unexpected destination without recorded child")
            except (RuntimeError, OSError):
                self.result["platformCleanupFailed"] = True
            raise  # Keep the initial capture failure; unresolved custody remains explicit.
        capture["roots"] = {"probe-tmp": Path(env["TMPDIR"]), "probe-hf-cache": Path(env["HF_HUB_CACHE"]), "probe-hf-home": Path(env["HF_HOME"]), "probe-home": home}
        child = capture["child"]
        try:
            require(not child.capture_overflow and not capture["failure"], "Foundation capture unavailable")
            record = foundation_record(bytes(child.stdout).strip(), child.process.pid, mode)
            require(capture["code"] == (0 if record["ok"] else 1), "Foundation exit disagrees with receipt")
        except (RuntimeError, ValueError, TypeError, KeyError):
            record = {"mode": mode, "pid": child.process.pid, "ok": False, "failure": "receipt-unavailable"}
        record["captureOverflow"] = child.capture_overflow
        record["stderrPresent"] = bool(child.stderr)
        # Persist the native error before a diagnostic collector can fail custody.
        self.result.setdefault("foundationAdmission", {})["primary" if mode == "download" else "secondary"] = record
        record["destinationCleanup"] = "unverified"
        record["destinationCleanup"] = self.cleanup_foundation_destination(pending, child, record.get("moved") is True)
        if not record["ok"]:
            try:
                record["sandboxDenials"] = self.denial_receipt(capture)
            except CaptureCustodyError:
                record["sandboxDenials"] = {"state": "custody-unverified", "records": []}
                raise
        return record

    def prepare_platform_staging(self):
        require_hosted_ci()
        source, binary = self.scratch / "foundation-admission.swift", self.scratch / "foundation-admission"
        source.write_text(FOUNDATION_SOURCE)
        compiled = self.quiet_capture(["swiftc", source, "-o", binary], 45)
        require(compiled["code"] == 0 and not compiled["child"].capture_overflow and not compiled["failure"], "Foundation probe compilation unavailable or failed")
        # Directory-only discovery is shared with full proof; it must not warm HTTP caches.
        self.admit_platform_temp(binary)
        return binary

    def foundation_admission(self):
        require_hosted_ci()
        self.begin("Foundation-only native download admission; no helper/model proof")
        receipt = {
            "probeSourceSHA256": hashlib.sha256(FOUNDATION_SOURCE.encode()).hexdigest(), "url": CONFIG_URL,
            "acceptedBytes": 680, "expectedGitBlob": FILES["config.json"][1],
            "byteLimitClaim": "application retained/accepted bytes; cancellation does not cap in-flight transfer or Foundation internal buffers",
            "credit": "Foundation-only admission; no helper, inference, offline cache or settings compatibility proof",
        }
        self.result["foundationAdmission"] = receipt
        binary = self.prepare_platform_staging()
        # The primary target must not be warmed by a same-URL dataTask control.
        primary = self.foundation_attempt(binary, "download")
        receipt["primary"] = primary
        if not primary["ok"]:
            receipt["secondaryCredit"] = "post-failure diagnostic only; cannot change primary failure"
            if time.monotonic() < self.budget.work_end:
                try:
                    receipt["secondary"] = self.foundation_attempt(binary, "data")
                except CaptureCustodyError:
                    raise
                except (RuntimeError, OSError):
                    receipt["secondary"] = {"ok": False, "failure": "unavailable"}
            else:
                receipt["secondary"] = {"ok": False, "failure": "budget-unavailable"}
            raise RuntimeError("Foundation native download admission failed; helper/model proof not run")
        receipt["pass"] = True

    def git(self, *args):
        return self.command(["git", *args], 30)

    def verify_source(self, source, revision):
        require(self.command(["git", "rev-parse", "HEAD"], 30, source) == revision, "selected checkout HEAD mismatch")
        blobs = {p: self.command(["git", "rev-parse", f"{revision}:{p}"], 30, source) for p in [*INPUTS, BAD_RESOLUTION]}
        for p, expected in blobs.items():
            actual = self.command(["git", "hash-object", p], 30, source)
            require(actual == expected, f"selected helper input differs: {p}")
        return {"sha": revision, "tree": self.command(["git", "rev-parse", f"{revision}^{{tree}}"], 30, source), "blobs": blobs}

    def snapshot(self, name, revision):
        self.begin(f"{name}: immutable source acquisition")
        # Add objects only. Never rewrite a branch, FETCH_HEAD, or shared worktree.
        exists = subprocess.run(["git", "cat-file", "-e", revision + "^{commit}"], cwd=self.checkout, env=self.env, capture_output=True).returncode == 0
        if not exists:
            self.command(["git", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "fetch", "--depth=1", "--no-auto-maintenance", "--no-write-commit-graph", "--no-tags", "--no-prune", "--no-prune-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--refmap=", "https://github.com/openclaw/openclaw.git", revision], 120)
        target = self.scratch / name
        target.mkdir()
        entries = self.git("ls-tree", "-r", revision, "--", PACKAGE, PROTOCOL).splitlines()
        blobs = {}
        # Export verified regular source files, not a mutable replacement manifest.
        for entry in entries:
            metadata, relative = entry.split("\t", 1)
            mode, kind, blob = metadata.split()
            require(kind == "blob" and mode in ["100644", "100755"], "unexpected snapshot entry")
            path = target / relative
            require(path.resolve().is_relative_to(target.resolve()), "snapshot path escapes owned root")
            path.parent.mkdir(parents=True, exist_ok=True)
            data = subprocess.run(["git", "cat-file", "blob", blob], cwd=self.checkout, env=self.env, capture_output=True, check=True).stdout
            require(len(data) <= 1024 * 1024, "snapshot file exceeds scoped source bound")
            require(hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest() == blob, "snapshot blob mismatch")
            path.write_bytes(data)
            path.chmod(int(mode, 8) & 0o777)
            blobs[relative] = blob
        require(all(p in blobs for p in INPUTS), "incomplete helper snapshot")
        self.result["variants"][name] = {"sha": revision, "tree": self.git("rev-parse", revision + "^{tree}"), "blobs": blobs}
        if name == "bad":
            self.prepare_bad_resolution(target, revision)
        return target

    def prepare_bad_resolution(self, source, revision):
        # The historical proposal retained an unused pin and stale origin hash.
        # Freeze the observed native resolution at export, so resolver drift still fails build().
        require(revision == BAD, "unexpected bad reference revision")
        manifest, lock = source / PACKAGE / "Package.swift", source / PACKAGE / "Package.resolved"
        require(digest(manifest) == BAD_MANIFEST_SHA256 and digest(lock) == BAD_LOCK_SHA256,
                "bad reference historical inputs differ")
        fixture = self.checkout / BAD_RESOLUTION
        require(fixture.is_file() and not fixture.is_symlink() and fixture.stat().st_size == 3119,
                "bad reference resolution fixture unavailable")
        data = fixture.read_bytes()
        blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        selected = self.result["source"]
        require(blob == selected["blobs"].get(BAD_RESOLUTION) and hashlib.sha256(data).hexdigest() == BAD_RESOLUTION_SHA256,
                "bad reference resolution fixture differs from committed native resolution")
        lock.write_bytes(data)
        self.result["variants"]["bad"]["referenceResolution"] = {
            "historicalLockSHA256": BAD_LOCK_SHA256, "buildLockSHA256": BAD_RESOLUTION_SHA256,
            "fixture": BAD_RESOLUTION, "fixtureSourceSHA": selected["sha"], "fixtureBlob": blob,
        }

    def build(self, name, source):
        self.begin(f"{name}: resolve and build")
        package = source / PACKAGE
        manifest, lock = package / "Package.swift", package / "Package.resolved"
        before = {"manifest": digest(manifest), "lock": digest(lock)}
        build = self.scratch / (name + "-build")
        self.command(["swift", "package", "--package-path", package, "--scratch-path", build, "resolve"], 120)
        after = {"manifest": digest(manifest), "lock": digest(lock)}
        info = self.result["variants"][name]
        info.update({"before": before, "resolved": after, "pins": json.loads(lock.read_text())["pins"]})
        expected_audio = {
            "stable": "3506fb93cc3b9e4a642079d5384eaca0373962e6",
            "bad": "6fd938669e45412f5c35e011e7086ecd20397dbd",
        }.get(name)
        if expected_audio:
            audio = next(pin for pin in info["pins"] if pin["identity"] == "mlx-audio-swift")
            require(audio["state"]["revision"] == expected_audio, f"{name}: wrong audio dependency baseline")
        if name == "fixed":
            for path in [manifest, lock]:
                shutil.copyfile(path, self.proof_dir / path.name)
            (self.proof_dir / "SHA256SUMS").write_text(f"{after['manifest']}  Package.swift\n{after['lock']}  Package.resolved\n")
        # A resolver mismatch is a setup failure, never the expected bad-cache red.
        info["committedResolutionMatches"] = before == after
        if name != "fixed":
            require(before == after, f"{name}: committed resolution changed")
        args = ["swift", "build", "--build-system", "swiftbuild", "--package-path", package, "-c", "debug", "--product", "openclaw-mlx-tts", "--build-path", build, "--arch", "arm64", "--disable-index-store", "-Xswiftc", "-gline-tables-only"]
        started = time.monotonic()
        self.command(args, 480)
        binary_dir = Path(self.command(args + ["--show-bin-path"], 30).splitlines()[-1])
        require(binary_dir.resolve().is_relative_to(build.resolve()), "Swift bin directory escapes owned build")
        binary = binary_dir / "openclaw-mlx-tts"
        library = binary_dir / "mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib"
        require(library.stat().st_size > 0, "missing MLX Metal resource")
        info.update({"buildSeconds": time.monotonic() - started, "binarySHA256": digest(binary), "metallibSHA256": digest(library)})
        probe_source = build / "metal-capability.swift"
        probe_source.write_text(METAL_SOURCE)
        probe = build / "metal-capability"
        self.command(["swiftc", "-framework", "Metal", "-framework", "CoreGraphics", probe_source, "-o", probe], 60)
        self.command([probe, library, "optional"], 30)
        if name == "fixed":
            self.command(["swift", "test", "--build-system", "swiftbuild", "--package-path", package, "-c", "debug", "--build-path", build, "--arch", "arm64", "--disable-index-store", "-Xswiftc", "-gline-tables-only", "--filter", "MLXTTSHelperServiceTests"], 120)
        require(before == {"manifest": digest(manifest), "lock": digest(lock)}, f"{name}: inputs changed during build/tests")
        return binary, library, probe

    def isolated_env(self, home, hub):
        home.mkdir(parents=True, exist_ok=True)
        tmp = home / "tmp"
        tmp.mkdir(exist_ok=True)
        return {**self.env, "HOME": str(home), "CFFIXED_USER_HOME": str(home), "TMPDIR": str(tmp), "HF_HOME": str(home / "hf"), "HF_HUB_CACHE": str(hub)}

    def sandbox(self, argv, online=False):
        profile = self.checkout / "scripts/macos-health-render.sb"
        if online:
            require_hosted_ci()
            require(self.platform_temp is not None and validate_platform_temp(self.platform_temp) == self.platform_temp,
                    "online profile requires admitted platform temp")
            # Permit cold download without dropping the existing home/Keychain policy.
            source = profile.read_bytes()
            network_deny = b"(deny network*)\n"
            require(source.count(network_deny) == 1, "online profile requires exactly one network denial")
            profile = self.scratch / "online.sb"
            profile.write_bytes(source.replace(network_deny, b"", 1) + b'\n(allow file-write* (subpath (param "PLATFORM_TEMP")))\n')
            self.result["coldIsolation"] = {
                "profileSHA256": digest(profile),
                "baseProfileSHA256": hashlib.sha256(source).hexdigest(),
                "policy": "owned HF cache and narrow environment; original-home and named Keychain/IPC restrictions retained",
                "hostAssumption": "protected github-hosted receipt; disposable canonical job VM/account",
                "sharedOSStoreIsolationProven": False,
            }
        parameters = ["-D", "PLATFORM_TEMP=" + str(self.platform_temp)] if online else []
        return ["/usr/bin/sandbox-exec", "-D", "ORIGINAL_HOME=" + os.environ["HOME"], "-D", "REPO=" + str(self.checkout), "-D", "ISOLATED_ROOT=" + str(self.scratch), *parameters, "-f", profile, *argv]

    def controls(self, variant):
        self.begin("offline sandbox network and Metal controls")
        binary, library, probe = variant
        env = self.isolated_env(self.scratch / "controls-home", self.cache_root / "controls")
        # Keep this listener open across all controls; no socket crosses close_fds.
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            server.listen(4)
            port = server.getsockname()[1]
            script = "import socket; s=socket.create_connection(('127.0.0.1'," + str(port) + "),timeout=3); s.close()"
            self.command([sys.executable, "-I", "-S", "-c", script], 10, env=env)
            negative = "import socket\ntry:\n s=socket.create_connection(('127.0.0.1'," + str(port) + "),timeout=3)\nexcept PermissionError:\n print('network-denied')\nelse:\n s.close(); raise SystemExit('sandbox allowed network')"
            require(self.command(self.sandbox([sys.executable, "-I", "-S", "-c", negative]), 10, env=env) == "network-denied", "offline denial control failed")
            self.command([sys.executable, "-I", "-S", "-c", script], 10, env=env)
            self.command(self.sandbox([sys.executable, "-I", "-S", "-c", script], online=True), 10, env=env)
        output = self.command(self.sandbox([probe, library, "required"]), 30, env=env)
        require("MLX Metal device:" in output and "MLX Metal library: available" in output, "sandboxed Metal admission failed")
        return {"network": "positive/denied/positive", "onlineProfileNetwork": "positive", "metal": output}

    def cache_size(self):
        paths = list(self.cache_root.rglob("*"))
        require(all(p.resolve().is_relative_to(self.cache_root.resolve()) for p in paths), "cache entry escapes owned root")
        size = sum(p.stat().st_size for p in paths if p.is_file())
        self.result["maxCacheBytes"] = max(size, self.result.get("maxCacheBytes", 0))
        require(size <= CACHE_LIMIT, "model cache exceeded 2 GiB")

    def model_files(self, root):
        result = {}
        for name, (size, expected) in FILES.items():
            p = root / name
            require(p.resolve().is_relative_to(self.cache_root.resolve()), "model file escapes owned cache")
            require(p.is_file() and p.stat().st_size == size, "model file size mismatch: " + name)
            if name == "model.safetensors":
                actual = digest(p)
            else:
                actual = hashlib.sha1(f"blob {size}\0".encode() + p.read_bytes()).hexdigest()
            require(actual == expected, "model file identity mismatch: " + name)
            result[name] = {"bytes": size, "digest": actual, "algorithm": "sha256" if name == "model.safetensors" else "git-blob-sha1"}
        return result

    def helper(self, name, variant, hub, offline=True):
        env = self.isolated_env(self.scratch / (name + "-home"), hub)
        argv = self.sandbox([variant[0]], online=not offline)
        child = Child(argv, self.checkout, env, framed=True, owner=self.children)
        child.on_tick = self.cache_size
        require(child.event(self.budget.deadline(30)) == {"type": "ready"}, "helper did not become ready")
        return child

    def request(self, child, name, stream=False, text=TEXT):
        child.send({"type": "synthesize", "synthesize": {"id": name, "text": text, "modelRepo": MODEL, "stream": stream}}, self.budget.deadline(10))

    def receive(self, child, deadline):
        self.cache_size()
        return child.event(deadline)

    def pcm(self, child, name, stream=False, seconds=120):
        self.request(child, name, stream)
        deadline = self.budget.deadline(seconds)
        total, nonzero, started = 0, False, False
        checksum, events = hashlib.sha256(), []
        while True:
            event = self.receive(child, deadline)
            kind = event.get("type")
            body = event.get(kind, event)
            require(body.get("id") == name, "unexpected helper response ID")
            events.append(kind)
            if kind == "stream_started":
                require(stream and not started, "unexpected stream start")
                require((body.get("format"), body.get("sampleRate"), body.get("channels")) == ("pcm_s16le", 32000, 1), "invalid stream format")
                started = True
            elif kind in ["audio", "audio_chunk"]:
                require(kind == ("audio_chunk" if stream else "audio"), "wrong audio response kind")
                if stream:
                    require(started, "audio preceded stream start")
                else:
                    require((body.get("format"), body.get("sampleRate"), body.get("channels")) == ("pcm_s16le", 32000, 1), "invalid PCM format")
                data = base64.b64decode(body["pcm"], validate=True)
                require(data and len(data) % 2 == 0, "empty or odd PCM payload")
                total += len(data)
                require(total <= PCM_LIMIT, "PCM exceeded request bound")
                nonzero |= any(data)
                checksum.update(data)
                if not stream:
                    break  # The real nonstreaming terminal event is audio, not completed.
            elif kind == "completed":
                require(stream and started, "unexpected completion")
                break
            else:
                raise RuntimeError("synthesis failed: " + json.dumps(event))
        require(total and nonzero, "PCM contains no nonzero sample")
        self.result["requests"].append({"id": name, "events": events, "pcmBytes": total, "pcmSHA256": checksum.hexdigest()})

    def active_cancel(self, child, name, shutdown=False):
        deadline = self.budget.deadline(30)
        self.request(child, name, text=ACTIVE_TEXT)
        self.request(child, name + "-busy")
        busy = self.receive(child, deadline)
        require(busy.get("type") == "error" and busy.get("error", {}).get("code") == "busy" and busy["error"].get("id") == name + "-busy", "active request completed before matching busy observation")
        # A busy response proves active ownership, not that GPU kernels have begun.
        child.send({"type": "shutdown"} if shutdown else {"type": "cancel", "id": name}, deadline)
        require(self.receive(child, deadline) == {"type": "canceled", "id": name}, "active request was not canceled before producing audio")
        self.result["requests"].append({"id": name, "events": ["busy", "canceled"], "kernelInterruptionProven": False})
        if shutdown:
            self.join_helper(child, deadline, name)

    def join_helper(self, child, deadline, name):
        started = time.monotonic()
        code = child.join(deadline)
        diagnostics = child.stderr.decode(errors="replace")
        # Native diagnostics can contain paths and request URLs; publish only a bounded, redacted tail.
        diagnostics = re.sub(r"(?:https?://|/)[^\s\"'<>]+", "<redacted-path-or-url>", diagnostics)
        diagnostics = re.sub(r"(?im)^.*(?:authorization|cookie|token|password|secret|api[-_]?key).*$", "<redacted-sensitive-line>", diagnostics)
        diagnostics = re.sub(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b", "<redacted-address>", diagnostics)
        diagnostics = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "<redacted-email>", diagnostics)
        self.result.setdefault("helperExits", []).append({
            "id": name, "returnCode": code, "signal": -code if code < 0 else None,
            "joinSeconds": time.monotonic() - started, "joined": True,
            "stderrBytes": child.stderr_bytes, "stderrSHA256": child.stderr_hash.hexdigest(),
            "stderrTail": diagnostics[-2048:],
            "stderrTailTruncated": child.stderr_bytes > len(child.stderr) or len(diagnostics) > 2048,
        })
        require(code == 0, f"shutdown did not exit cleanly (exit {code})")

    def stop_helper(self, child):
        child.send({"type": "shutdown"}, self.budget.deadline(10))
        self.join_helper(child, self.budget.deadline(15), "idle-shutdown")

    def extended(self, fixed):
        self.result["controls"] = {"fixed": self.controls(fixed)}
        self.begin("fixed: real empty-cache online bootstrap (not offline proof)")
        # The native helper has no revision argument. Bind both sides of its main lookup.
        with urllib.request.urlopen(f"https://huggingface.co/api/models/{MODEL}/revision/main", timeout=10) as response:
            metadata = response.read(1024 * 1024 + 1)
        require(len(metadata) <= 1024 * 1024 and json.loads(metadata)["sha"] == REVISION, "public model main moved")
        cold = self.cache_root / "cold"
        cold.mkdir()
        child = self.helper("cold", fixed, cold, offline=False)
        self.pcm(child, "cold-native-download", seconds=240)
        self.stop_helper(child)
        model_root = cold / "mlx-audio/mlx-community_Soprano-80M-bf16"
        require(json.loads((model_root / ".mlx-audio-snapshot.json").read_text())["revision"] == REVISION, "native snapshot revision mismatch")
        self.result["model"] = {"repo": MODEL, "revision": REVISION, "license": "Apache-2.0", "files": self.model_files(model_root)}
        legacy = self.cache_root / "stable-used/mlx-audio/mlx-community_Soprano-80M-bf16"
        bad_legacy = self.cache_root / "bad/mlx-audio/mlx-community_Soprano-80M-bf16"
        for target in [legacy, bad_legacy]:
            target.mkdir(parents=True)
            for name in FILES:
                shutil.copyfile(model_root / name, target / name)
            self.model_files(target)
        self.result["legacyFixture"] = "six verified native-downloaded files; not a stable-created download; no snapshot/HTTP metadata"
        self.cache_size()
        for name, revision in [("stable", STABLE), ("bad", BAD)]:
            source = self.snapshot(name, revision)
            variant = self.build(name, source)
            self.result["controls"][name] = self.controls(variant)
            self.begin(name + ": legacy cache under enforced offline boundary")
            hub = legacy.parent.parent if name == "stable" else bad_legacy.parent.parent
            child = self.helper(name, variant, hub)
            if name == "stable":
                self.pcm(child, "stable-offline")
            else:
                self.request(child, "bad-offline")
                event = self.receive(child, self.budget.deadline(120))
                self.result["badCacheRed"] = denied_cache_error(event)
            self.stop_helper(child)
            self.model_files(legacy if name == "stable" else bad_legacy)
        self.begin("fixed: retained stable-used offline cache and real lifecycle")
        child = self.helper("fixed-offline", fixed, legacy.parent.parent)
        self.pcm(child, "fixed-retained-offline")
        self.pcm(child, "fixed-stream", stream=True)
        self.active_cancel(child, "fixed-cancel")
        self.pcm(child, "fixed-after-cancel")
        self.active_cancel(child, "fixed-shutdown", shutdown=True)
        self.model_files(legacy)
        self.result["offlineHelperCacheComplete"] = True
        self.result["settingsUpgradeComplete"] = False

    def execute(self, extended, foundation_only=False):
        require(not foundation_only or extended, "Foundation admission-only requires extended admission")
        revision = os.environ["CHECKOUT_SHA"]
        require(re.fullmatch(r"[0-9a-f]{40}", revision), "invalid selected checkout SHA")
        self.result.update({"source": self.verify_source(self.checkout, revision), "workflowSHA": os.environ.get("GITHUB_WORKFLOW_SHA"), "triggerSHA": os.environ.get("GITHUB_SHA"), "run": os.environ["GITHUB_RUN_ID"], "attempt": os.environ["GITHUB_RUN_ATTEMPT"], "extended": extended})
        self.result["variants"]["fixed"] = dict(self.result["source"])
        (self.proof_dir / "source.txt").write_text(f"source_sha={revision}\nrun_id={os.environ['GITHUB_RUN_ID']}\nrun_attempt={os.environ['GITHUB_RUN_ATTEMPT']}\njob={os.environ['GITHUB_JOB']}\n")
        if foundation_only:
            self.result.update({"diagnosticOnly": True, "helperBuildRun": False, "modelInferenceRun": False, "offlineHelperCacheComplete": False, "settingsUpgradeComplete": False})
            self.foundation_admission()
            self.result["diagnosticComplete"] = True
            return  # Deliberately do not mark the full native compatibility proof complete.
        fixed = self.build("fixed", self.checkout)
        if extended:
            self.prepare_platform_staging()
            self.extended(fixed)
        self.result["complete"] = True

    def close(self):
        joined = True
        for child in self.children:
            try:
                child.retire(self.budget.cleanup_end)
            except Exception as error:
                joined = False
                self.result.setdefault("cleanupErrors", []).append(str(error))
        self.result["processesAndPipesRetired"] = joined
        self.result["platformDestinationsRetired"] = all(pending["retired"] for pending in self.platform_destinations)
        removable = joined and self.result["platformDestinationsRetired"] and not self.result.get("captureCustodyFailed", False) and not self.result.get("platformCleanupFailed", False)
        if removable:
            shutil.rmtree(self.scratch)
        self.result["scratchRemoved"] = removable
        self.result["complete"] = self.result["complete"] and removable
        # No model weights, audio, tokens, raw HOME, or unbounded logs become artifacts.
        payload = json.dumps(self.result, indent=2, sort_keys=True).replace(str(self.scratch), "<owned-scratch>").replace(str(self.checkout), "<checkout>").replace(os.environ["HOME"], "<runner-home>")
        require(len(payload.encode()) <= 128 * 1024, "native proof metadata exceeded artifact bound")
        (self.proof_dir / "native-proof.json").write_text(payload + "\n")
        require(joined and self.result["platformDestinationsRetired"], "native proof cleanup is incomplete")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proof-dir", type=Path, required=True)
    parser.add_argument("--started", type=float, required=True)
    parser.add_argument("--extended", action="store_true")
    parser.add_argument("--foundation-admission-only", action="store_true")
    args = parser.parse_args()
    require(not args.foundation_admission_only or args.extended, "Foundation admission-only requires extended admission")
    require(sys.platform == "darwin" and os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_REPOSITORY") == "openclaw/openclaw", "native MLX proof requires disposable canonical macOS CI")
    if args.extended:
        require_hosted_ci()
    runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    proof_dir = args.proof_dir.resolve(strict=True)
    require(proof_dir.is_relative_to(runner_temp) and proof_dir != runner_temp and not args.proof_dir.is_symlink(), "proof directory is not owned runner scratch")
    budget = Budget(args.started)
    scratch = Path(tempfile.mkdtemp(prefix="openclaw-mlx-native-", dir=runner_temp)).resolve()
    proof = Proof(Path.cwd().resolve(), scratch, proof_dir, budget)
    previous = signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        proof.execute(args.extended, args.foundation_admission_only)
    except BaseException as error:
        proof.result["failure"] = {"phase": proof.phase, "detail": str(error)}
        raise
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        try:
            proof.close()
        finally:
            signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        print(f"[mlx-native] FAILED (exit 1): {error}", file=sys.stderr)
        sys.exit(1)
