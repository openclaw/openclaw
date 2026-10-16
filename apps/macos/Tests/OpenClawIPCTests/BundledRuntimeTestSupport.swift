import CryptoKit
import Foundation

func makeBundledRuntimeTestBundle(
    at root: URL,
    builtAt: String,
    buildID: String? = nil,
    command: String,
    warmScript: String = "",
    doctorScript: String? = nil) throws -> URL
{
    let info: [String: Any] = [
        "CFBundleIdentifier": "ai.openclaw.mac.debug",
        "CFBundleExecutable": "OpenClaw",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "2026.8.1",
        "CFBundleVersion": "1",
        "OpenClawGitCommit": String(repeating: "a", count: 40),
        "OpenClawBuildTimestamp": builtAt,
        "OpenClawRuntimeBuildID": buildID ?? builtAt,
    ]
    try FileManager.default.createDirectory(
        at: root.appendingPathComponent("Contents/MacOS"),
        withIntermediateDirectories: true)
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        .write(to: root.appendingPathComponent("Contents/Info.plist"))
    try makeExecutableForTests(at: root.appendingPathComponent("Contents/MacOS/openclaw-mac"))
    let runtime = root.appendingPathComponent("Contents/Resources/runtime")
    let dist = runtime.appendingPathComponent("runtime/dist")
    try FileManager.default.createDirectory(at: dist, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
        at: runtime.appendingPathComponent("runtime/lib"),
        withIntermediateDirectories: true)
    let doctorCase = doctorScript.map { "doctor)\n\($0)\n;;" } ?? ""
    // A real child process protects command/profile/lifecycle behavior; release proof uses the compiled executable.
    try """
    #!/bin/sh
    if [ "$1" = --version ]; then
      echo probe >> "${0%/openclaw}/version-probes"
      \(warmScript)
      echo 2026.8.1
      exit 0
    fi
    case "$1" in
      */dist/mac-node-worker.js)
        [ "${PATH%%:*}" = "${0%/openclaw}" ] || exit 91
        printf '{"type":"ready","version":"2026.8.1","manifest":{"caps":["system"],"commands":["\(command)"],"pathEnv":"%s"}}\\n' "$OPENCLAW_SQLITE_LIBRARY"
        while IFS= read -r line; do :; done
        ;;
      */dist/extensions/browser/setup-entry.js) exit 0 ;;
      \(doctorCase)
      *) printf '%s\\n' "$OPENCLAW_PROFILE" "$OPENCLAW_SQLITE_LIBRARY" "$@" ;;
    esac

    """.write(to: runtime.appendingPathComponent("openclaw"), atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
        [.posixPermissions: 0o755],
        ofItemAtPath: runtime.appendingPathComponent("openclaw").path)
    try Data().write(to: runtime.appendingPathComponent("runtime/lib/libsqlite3.dylib"))
    try JSONSerialization.data(withJSONObject: [
        "schemaVersion": 1, "mode": "jit", "buildId": buildID ?? builtAt,
        "openclaw": ["version": "2026.8.1", "commit": String(repeating: "a", count: 40)],
        "executable": [
            "path": "openclaw",
            "sizeBytes": Data(contentsOf: runtime.appendingPathComponent("openclaw")).count,
            "sha256": SHA256.hash(data: Data(contentsOf: runtime.appendingPathComponent("openclaw")))
                .map { String(format: "%02x", $0) }.joined(),
        ],
        "runtime": ["path": "runtime", "sizeBytes": 0],
    ]).write(to: runtime.appendingPathComponent("manifest.json"))
    try Data().write(to: dist.appendingPathComponent("mac-node-worker.js"))
    let browser = dist.appendingPathComponent("extensions/browser")
    try FileManager.default.createDirectory(at: browser, withIntermediateDirectories: true)
    try Data().write(to: browser.appendingPathComponent("setup-entry.js"))
    return dist
}
