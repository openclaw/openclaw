# iOS App Security, Networking & Performance Audit

**Date:** 2026-03-02
**Scope:** `apps/ios/Sources/`, `apps/shared/OpenClawKit/Sources/` (security-relevant shared code), `apps/ios/project.yml`, entitlements
**Auditor:** Security & Performance Audit Agent

---

## 1. Security Posture Overview

The OpenClaw iOS app demonstrates a **generally strong security posture** for a local-network gateway client. Key strengths include:

- **Keychain usage for credentials:** Gateway tokens, passwords, instance IDs, and API keys are stored in Keychain (not UserDefaults).
- **TLS certificate pinning:** SHA-256 certificate fingerprint pinning is implemented for gateway WebSocket connections via `GatewayTLSPinningSession`.
- **Trust-on-first-use (TOFU) with user confirmation:** New gateway TLS fingerprints require explicit user approval before trust is established.
- **Deep link confirmation:** Agent deep links (the `openclaw://` URL scheme) require user confirmation before execution, with message length limits.
- **Web view security:** The canvas WKWebView uses `.nonPersistent()` data store and validates that A2UI action messages originate only from trusted/local-network URLs.
- **Input sanitization:** Consistent `.trimmingCharacters(in: .whitespacesAndNewlines)` throughout, input length limits on contacts/calendar/photos queries.
- **Permission gating:** All hardware capabilities (camera, location, microphone, contacts, calendar, photos) check authorization status before access.
- **No hardcoded secrets:** No API keys, tokens, or credentials are hardcoded in the source.
- **Swift 6 strict concurrency:** Enabled project-wide (`SWIFT_STRICT_CONCURRENCY: complete`), reducing data race risks.

---

## 2. Critical Severity Findings

*No critical vulnerabilities identified.*

The app does not store plaintext passwords in UserDefaults, does not embed secrets, does not disable ATS globally, and does not allow arbitrary code execution from untrusted sources. The attack surface is primarily local-network, which limits remote exploitation vectors.

---

## 3. High Severity Findings

### H-1: TLS Fingerprints Stored in UserDefaults Instead of Keychain

**File:** `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayTLSPinning.swift:19-38`
**Severity:** HIGH

`GatewayTLSStore` stores TLS certificate fingerprints in `UserDefaults(suiteName: "ai.openclaw.shared")`. While fingerprints themselves are not secrets, they serve as the trust anchor for the TLS pinning system. An attacker with access to the device backup (unencrypted iTunes/Finder backup) or a compromised app extension sharing the same suite could modify these fingerprints and redirect gateway connections to a malicious server.

**Exploit scenario:** An attacker with physical or backup access modifies the stored fingerprint for a known gateway stableID, then performs a MITM attack on the LAN. The app connects using the attacker's fingerprint as the expected pin.

**Recommended fix:** Store TLS fingerprints in Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (matching the existing `KeychainStore` pattern). This prevents backup extraction and cross-device compromise.

---

### H-2: KeychainStore Update Path Does Not Set Accessibility Level

**File:** `apps/ios/Sources/Gateway/KeychainStore.swift:20-37`
**Severity:** HIGH

In `saveString()`, when the item already exists (`SecItemUpdate` succeeds), the update does not set or enforce the `kSecAttrAccessible` attribute. Only new items (via `SecItemAdd`) get `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. If a Keychain item was originally created with a less restrictive accessibility level (e.g., during a migration or by an older version), it retains that weaker level after updates.

**Exploit scenario:** An older app version or a migration path creates a Keychain item without specifying `kSecAttrAccessible` (defaults to `kSecAttrAccessibleWhenUnlocked`). After upgrading, the item retains the old accessibility level, potentially making it accessible via iCloud Keychain sync.

**Recommended fix:** Before `SecItemUpdate`, delete and re-add the item with the correct accessibility attribute, or explicitly include `kSecAttrAccessible` in the update query attributes. Example:

```swift
// Delete-then-add pattern for consistent accessibility
SecItemDelete(query as CFDictionary)
var insert = query
insert[kSecValueData as String] = data
insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
```

---

### H-3: Gateway Connection Metadata in UserDefaults

**File:** `apps/ios/Sources/Gateway/GatewaySettingsStore.swift:170-217`
**Severity:** HIGH

Last-known gateway connection details (host, port, TLS flag, stableID, connection kind) are stored in `UserDefaults.standard`. This data reveals which gateway servers the user connects to, their network topology, and connection preferences. UserDefaults are included in unencrypted device backups and can be read by MDM profiles or forensic tools.

**Affected keys:** `gateway.last.kind`, `gateway.last.host`, `gateway.last.port`, `gateway.last.tls`, `gateway.last.stableID`, `gateway.manual.host`, `gateway.manual.port`, `gateway.manual.tls`, `gateway.manual.clientId`, `gateway.clientIdOverride.*`, `gateway.selectedAgentId.*`.

**Recommended fix:** Move gateway connection metadata that reveals network topology to Keychain or use `NSFileProtectionCompleteUntilFirstUserAuthentication` on a dedicated plist file in the app's data directory.

---

## 4. Medium Severity Findings

### M-1: `NSAllowsArbitraryLoadsInWebContent` Enabled

**File:** `apps/ios/project.yml:110`
**Severity:** MEDIUM

```yaml
NSAppTransportSecurity:
  NSAllowsArbitraryLoadsInWebContent: true
```

This disables ATS protections for WKWebView content. While necessary for the canvas to load user-specified URLs from the gateway (including local-network HTTP servers), it means the web view can load insecure HTTP resources. The `ScreenController.navigate()` method does filter out loopback URLs but does not enforce HTTPS for remote URLs.

**Exploit scenario:** A gateway instructs the canvas to load an HTTP URL on a public network. The content is intercepted/modified via MITM.

**Recommended fix:** This is largely an accepted risk given the product's design (canvas loads gateway-specified URLs). Consider adding a user-visible indicator when the canvas is loading non-HTTPS content, and log a warning.

---

### M-2: Diagnostic Log File Written to Documents Directory Without Protection

**File:** `apps/ios/Sources/Gateway/GatewaySettingsStore.swift:359-448`
**Severity:** MEDIUM

`GatewayDiagnostics` writes logs to `Documents/openclaw-gateway.log`. The Documents directory is accessible via iTunes file sharing (if enabled) and is included in device backups. Log entries include timestamps and gateway connection events which could reveal usage patterns.

Logs are written with `privacy: .public` in the `os.Logger` calls, meaning they are also visible in `Console.app` sysdiagnose captures without redaction.

**Recommended fix:** Write diagnostic logs to `Library/Caches/` instead (excluded from backups), apply `NSFileProtectionCompleteUntilFirstUserAuthentication`, and consider using `privacy: .private` or `privacy: .auto` for log messages that may contain sensitive connection details.

---

### M-3: Environment Variable Fallback for ElevenLabs API Key

**File:** `apps/ios/Sources/Voice/TalkModeManager.swift:991-992`
**Severity:** MEDIUM

```swift
ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"]
```

The talk mode manager reads API keys from environment variables as a fallback. While environment variables are not accessible to other apps on iOS, they persist in process memory and could be captured in crash reports. This pattern is more suitable for development/debugging and should not ship in production builds.

**Recommended fix:** Gate this fallback behind `#if DEBUG` to prevent production builds from reading API keys from environment variables.

---

### M-4: Instance ID Dual-Storage Creates Sync Risk

**File:** `apps/ios/Sources/Gateway/GatewaySettingsStore.swift:291-312`
**Severity:** MEDIUM

`ensureStableInstanceID()` maintains the instance ID in both Keychain and UserDefaults (`node.instanceId`). If either store is cleared independently (e.g., Keychain reset during device restore without backup, or UserDefaults cleared by storage pressure), the sync logic may create a new UUID, effectively orphaning the device's gateway registration.

While this is a robustness concern rather than a direct vulnerability, an attacker who can clear UserDefaults (e.g., via an MDM-deployed configuration profile) could force a device identity reset.

**Recommended fix:** Designate Keychain as the single source of truth and only mirror to UserDefaults for read convenience. Document the recovery flow for identity reset.

---

### M-5: No Rate Limiting on Deep Link Agent Prompts

**File:** `apps/ios/Sources/Model/NodeAppModel.swift:43-45, 92`
**Severity:** MEDIUM

The `IOSDeepLinkAgentPolicy` defines `maxMessageChars = 20000` and `maxUnkeyedConfirmChars = 240`, and there is a `lastAgentDeepLinkPromptAt` timestamp. However, without a minimum interval check, a malicious webpage or app could rapidly fire `openclaw://` deep links, creating a flood of confirmation dialogs that degrade UX and potentially trick users into accepting a malicious prompt through fatigue.

**Recommended fix:** Enforce a minimum interval (e.g., 5 seconds) between successive deep link prompts, silently dropping duplicates. The `lastAgentDeepLinkPromptAt` field exists but its enforcement should be verified.

---

### M-6: QR Code Parsing Accepts Multiple Formats Without Strict Validation

**File:** `apps/ios/Sources/Onboarding/QRScannerView.swift:63-85`
**Severity:** MEDIUM

The QR scanner tries two parsing strategies: `GatewayConnectDeepLink.fromSetupCode(payload)` (base64url JSON) and `DeepLinkParser.parse(url)` (URL format). The `GatewaySetupCode.decode()` method (`apps/ios/Sources/Gateway/GatewaySetupCode.swift`) accepts arbitrary base64-encoded JSON payloads that decode into `GatewaySetupPayload`. There is no signature verification or HMAC on the QR code content.

**Exploit scenario:** An attacker places a malicious QR code that encodes a gateway URL pointing to their controlled server. When scanned, the user is prompted to connect to the attacker's gateway.

**Mitigating factors:** The TLS trust prompt still fires for new gateways, requiring explicit user approval of the certificate fingerprint.

**Recommended fix:** Consider adding an HMAC or signing mechanism to QR setup codes so the app can verify they were generated by the user's own gateway. At minimum, clearly display the gateway URL/host to the user during the onboarding flow.

---

### M-7: WebSocket Maximum Message Size Set to 16 MB

**File:** `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayTLSPinning.swift:55`
**Severity:** MEDIUM (Performance/DoS)

```swift
task.maximumMessageSize = 16 * 1024 * 1024
```

A malicious or compromised gateway could send a 16 MB WebSocket message, causing a significant memory spike on the iOS device.

**Recommended fix:** Evaluate whether 16 MB is necessary. Consider progressive parsing or streaming for large payloads. Add a sanity check on incoming message size.

---

## 5. Low Severity Findings

### L-1: Location Data Sent Over Gateway WebSocket Without End-to-End Encryption

**File:** `apps/ios/Sources/Location/SignificantLocationMonitor.swift:21-38`
**Severity:** LOW

Significant location updates (lat, lon, accuracy) are sent as JSON over the gateway WebSocket. While the WebSocket uses TLS (wss://), the gateway server itself can read the location data in plaintext. This is by design (the gateway processes location for hooks), but users should be informed that location data is accessible to the gateway process.

**Recommended fix:** Document this clearly in privacy documentation. Consider allowing users to configure location precision (rounding to neighborhood-level vs. exact coordinates).

---

### L-2: Camera Photo/Video Base64 Encoding in Memory

**Files:** `apps/ios/Sources/Camera/CameraController.swift:84`, `apps/ios/Sources/Media/PhotoLibraryService.swift:105`
**Severity:** LOW

Camera captures and photo library images are base64-encoded in memory before being sent over the gateway. For large images (up to 1600px wide at 0.9 quality), this means the raw image data plus the base64 string (33% larger) coexist in memory briefly.

**Mitigating factors:** The app already clamps max width to 1600px and applies quality compression. Temporary files are cleaned up via `defer` blocks.

**Recommended fix:** Consider streaming base64 encoding or using a memory-mapped approach for very large payloads. Current implementation is adequate for the existing size limits.

---

### L-3: Screen Recording Output Path User-Controllable

**File:** `apps/ios/Sources/Screen/ScreenRecordService.swift:103-109`
**Severity:** LOW

The `makeOutputURL` method accepts an optional `outPath` parameter. If this comes from a gateway command, a malicious gateway could specify a path outside the app's sandbox (which iOS would block) or overwrite files within the sandbox.

**Mitigating factors:** iOS sandbox prevents writing outside the app container. The `defer` cleanup in the caller should handle temporary files.

**Recommended fix:** Validate that `outPath` is within the app's temporary or documents directory before using it. Reject absolute paths that don't start with the app's known writable directories.

---

### L-4: Voice Wake Preferences Stored in UserDefaults

**File:** `apps/ios/Sources/Voice/VoiceWakePreferences.swift:23-29`
**Severity:** LOW

Trigger words and voice wake enabled state are stored in `UserDefaults.standard`. While trigger words are not sensitive per se, they reveal user behavior patterns.

**Recommended fix:** Acceptable for non-sensitive preferences. No action needed unless trigger words become user-configurable sensitive phrases.

---

### L-5: `nonisolated(unsafe)` in GatewayDiagnostics

**File:** `apps/ios/Sources/Gateway/GatewaySettingsStore.swift:358`
**Severity:** LOW

```swift
nonisolated(unsafe) private static var logWritesSinceCheck = 0
```

This counter is accessed from the `DispatchQueue` without the lock that protects the file I/O. While this is a benign data race (used only for approximate frequency gating), it could theoretically cause the log size check to be skipped or double-triggered.

**Recommended fix:** Move the counter into the `queue.async` block or use an atomic counter.

---

### L-6: `objc_sync_enter` Used for Synchronization

**File:** `apps/ios/Sources/Gateway/GatewayConnectionController.swift:1039-1040`
**Severity:** LOW

`GatewayTLSFingerprintProbe.finish()` uses `objc_sync_enter/exit` for synchronization. This is the Objective-C `@synchronized` primitive. While functional, modern Swift best practice prefers `OSAllocatedUnfairLock` (as used correctly in `TCPProbe`), `NSLock`, or actor isolation.

**Recommended fix:** Replace with `OSAllocatedUnfairLock` for consistency with the rest of the codebase.

---

### L-7: No Certificate Revocation Checking

**File:** `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayTLSPinning.swift:59-96`
**Severity:** LOW

The TLS pinning implementation checks the certificate fingerprint but does not perform OCSP or CRL revocation checking. For self-signed certificates (typical in local gateway setups), this is expected. For publicly-signed certificates, revocation checking would add defense in depth.

**Recommended fix:** For the current use case (self-signed gateway certs on LAN), this is acceptable. If public CA certificates are used in future, consider enabling revocation checking via `SecTrustSetOptions`.

---

## 6. Performance Concerns

### P-1: ISO8601DateFormatter Created Per Log Entry

**File:** `apps/ios/Sources/Gateway/GatewaySettingsStore.swift:422-424`
**Severity:** LOW

`GatewayDiagnostics.log()` creates a new `ISO8601DateFormatter` for every log call. `ISO8601DateFormatter` is relatively expensive to initialize.

**Recommended fix:** Cache a static formatter instance (thread-safety is acceptable for `ISO8601DateFormatter` as it is immutable after configuration).

---

### P-2: Observation Tracking Re-registration Pattern

**File:** `apps/ios/Sources/Gateway/GatewayConnectionController.swift:293-305`
**Severity:** LOW

The `observeDiscovery()` method uses `withObservationTracking` and recursively calls itself in the `onChange` closure. This is the standard Swift Observation pattern, but each change creates a new `Task` and re-registers tracking. Under rapid discovery state changes, this could create a burst of Task allocations.

**Mitigating factors:** Discovery state changes are infrequent (Bonjour events).

**Recommended fix:** Consider debouncing or coalescing rapid state changes.

---

### P-3: Synchronous Photo Library Access

**File:** `apps/ios/Sources/Media/PhotoLibraryService.swift:69-71`
**Severity:** MEDIUM (Performance)

```swift
options.isSynchronous = true
```

`PHImageManager.requestImage` is called synchronously, which blocks the calling thread until the image is loaded and decoded. For network-backed assets (iCloud Photo Library), this could block for seconds.

**Recommended fix:** Use asynchronous image loading with a continuation wrapper to avoid blocking.

---

### P-4: Camera Clip Base64 Encoding of Video Data

**File:** `apps/ios/Sources/Camera/CameraController.swift:89-140`
**Severity:** LOW

Video clips (up to 60 seconds) are fully loaded into memory as `Data` and then base64-encoded. A 60-second medium-quality MP4 could be 10-30 MB, producing a 13-40 MB base64 string in memory.

**Mitigating factors:** Default duration is 3 seconds, keeping typical payloads small. The 60-second max is enforced at `CameraController.clampDurationMs`.

**Recommended fix:** Consider a streaming upload mechanism for clips longer than ~10 seconds.

---

## 7. OWASP Mobile Top 10 2024 Checklist

| # | OWASP Category | Status | Notes |
|---|---------------|--------|-------|
| M1 | Improper Credential Usage | **PASS** | Credentials stored in Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. No hardcoded secrets. API keys from env vars gated to dev builds (recommended). |
| M2 | Inadequate Supply Chain Security | **PASS** | Dependencies are version-pinned via Package.resolved. SwiftLint and SwiftFormat enforce code quality. |
| M3 | Insecure Authentication/Authorization | **PASS** | Gateway authentication uses token + password stored in Keychain. TLS pinning prevents MITM. Deep links require user confirmation. |
| M4 | Insufficient Input/Output Validation | **PASS** | Input trimming and length limits applied consistently. QR code parsing has two validated paths. Calendar/contacts sanitize inputs. |
| M5 | Insecure Communication | **PASS with notes** | TLS required for non-loopback connections. Certificate pinning implemented. `NSAllowsArbitraryLoadsInWebContent` allows HTTP in web views (accepted risk for canvas). |
| M6 | Inadequate Privacy Controls | **PASS with notes** | All sensitive permissions have usage descriptions. Location data sent to gateway in plaintext over TLS. Photo library access checks authorization. Logging uses `privacy: .public` for some potentially sensitive data. |
| M7 | Insufficient Binary Protections | **N/A** | Standard Xcode compilation. No jailbreak detection implemented (acceptable for non-financial app). |
| M8 | Security Misconfiguration | **PASS with notes** | TLS fingerprints in UserDefaults (H-1). Gateway metadata in UserDefaults (H-3). Entitlements minimal (only `aps-environment`). |
| M9 | Insecure Data Storage | **PASS with notes** | Credentials in Keychain (good). Gateway connection metadata in UserDefaults (H-3). Diagnostic logs in Documents directory (M-2). |
| M10 | Insufficient Cryptography | **PASS** | SHA-256 for certificate fingerprinting via CryptoKit. No custom/weak crypto implementations. |

---

## 8. Summary of Recommendations by Priority

### Immediate (High)
1. **H-1:** Move TLS fingerprint storage from UserDefaults to Keychain
2. **H-2:** Fix KeychainStore to enforce accessibility level on updates (delete + re-add)
3. **H-3:** Move gateway connection metadata out of UserDefaults

### Short-term (Medium)
4. **M-3:** Gate `ELEVENLABS_API_KEY` env var fallback behind `#if DEBUG`
5. **M-2:** Move diagnostic logs to Caches directory, apply file protection
6. **M-5:** Enforce minimum interval between deep link prompts
7. **M-6:** Add HMAC/signature to QR setup codes
8. **M-7:** Evaluate reducing WebSocket max message size from 16 MB
9. **P-3:** Convert synchronous photo library loading to async

### Long-term (Low / Hardening)
10. **L-6:** Replace `objc_sync_enter` with `OSAllocatedUnfairLock`
11. **L-3:** Validate screen recording output paths
12. **P-1:** Cache ISO8601DateFormatter instances
13. **M-1:** Add indicator for non-HTTPS canvas content
14. **L-5:** Fix `nonisolated(unsafe)` data race in log counter

---

## 9. Positive Security Patterns Worth Preserving

- **TOFU with explicit user confirmation** for TLS fingerprints is a pragmatic and user-friendly approach for self-signed certificates.
- **Dual WebSocket sessions** (node + operator) with separate role scoping provides good privilege separation.
- **`websiteDataStore = .nonPersistent()`** for the canvas WKWebView prevents session data leakage.
- **Origin validation in `CanvasA2UIActionMessageHandler`** (checking `isTrustedCanvasUIURL` and `isLocalNetworkCanvasURL`) is a strong defense against arbitrary web content triggering actions.
- **Loopback URL rejection** in `ScreenController.navigate()` prevents SSRF-like attacks from the gateway.
- **Autoconnect only to previously trusted gateways** (stored TLS pin required) prevents connecting to rogue gateways after TOFU.
- **Permission checks before hardware access** with clear error messages is well-implemented.
- **`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`** is the correct Keychain accessibility level for this use case (device-local, available after first unlock for background operation).
