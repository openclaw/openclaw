import CoreLocation
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacNodeRuntimeTests {
    @Test func `handle invoke rejects unknown command`() async {
        let runtime = MacNodeRuntime()
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-1", command: "unknown.command"))
        #expect(response.ok == false)
    }

    @Test func `handle invoke rejects empty system run`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemRunParams(command: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2", command: OpenClawSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke rejects blocked system run env override before execution`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemRunParams(
            command: ["/bin/sh", "-lc", "echo ok"],
            env: ["CLASSPATH": "/tmp/evil-classpath"])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2c", command: OpenClawSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
        #expect(response.error?.message.contains("SYSTEM_RUN_DENIED: environment override rejected") == true)
        #expect(response.error?.message.contains("CLASSPATH") == true)
    }

    @Test func `handle invoke rejects invalid system run env override key before execution`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemRunParams(
            command: ["/bin/sh", "-lc", "echo ok"],
            env: ["BAD-KEY": "x"])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2d", command: OpenClawSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
        #expect(response.error?.message.contains("SYSTEM_RUN_DENIED: environment override rejected") == true)
        #expect(response.error?.message.contains("BAD-KEY") == true)
    }

    @Test func `handle invoke rejects empty system which`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemWhichParams(bins: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2b", command: OpenClawSystemCommand.which.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke rejects empty notification`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemNotifyParams(title: "", body: "")
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-3", command: OpenClawSystemCommand.notify.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke camera list requires enabled camera`() async {
        await TestIsolation.withUserDefaultsValues([cameraEnabledKey: false]) {
            let runtime = MacNodeRuntime()
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(id: "req-4", command: OpenClawCameraCommand.list.rawValue))
            #expect(response.ok == false)
            #expect(response.error?.message.contains("CAMERA_DISABLED") == true)
        }
    }

    @Test func `handle invoke screen record uses injected services`() async throws {
        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            func snapshotScreen(
                screenIndex: Int?,
                maxWidth: Int?,
                quality: Double?,
                format: OpenClawScreenSnapshotFormat?) async throws
                -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)
            {
                _ = screenIndex
                _ = maxWidth
                _ = quality
                return (Data("snapshot".utf8), format ?? .jpeg, 640, 360)
            }

            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus {
                .authorizedAlways
            }

            func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
                .fullAccuracy
            }

            func currentLocation(
                desiredAccuracy: OpenClawLocationAccuracy,
                maxAgeMs: Int?,
                timeoutMs: Int?) async throws -> CLLocation
            {
                CLLocation(latitude: 0, longitude: 0)
            }
        }

        let services = await MainActor.run { FakeMainActorServices() }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let params = MacNodeScreenRecordParams(durationMs: 250)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-5", command: MacNodeScreenCommand.record.rawValue, paramsJSON: json))
        #expect(response.ok == true)
        let payloadJSON = try #require(response.payloadJSON)

        struct Payload: Decodable {
            var format: String
            var base64: String
        }
        let payload = try JSONDecoder().decode(Payload.self, from: Data(payloadJSON.utf8))
        #expect(payload.format == "mp4")
        #expect(!payload.base64.isEmpty)
    }

    @Test func `handle invoke screen snapshot uses injected services`() async throws {
        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            var snapshotCalledAtMs: Int64?

            func snapshotScreen(
                screenIndex: Int?,
                maxWidth: Int?,
                quality: Double?,
                format: OpenClawScreenSnapshotFormat?) async throws
                -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)
            {
                self.snapshotCalledAtMs = Int64(Date().timeIntervalSince1970 * 1000)
                #expect(screenIndex == 0)
                #expect(maxWidth == 800)
                #expect(quality == 0.5)
                return (Data("ok".utf8), format ?? .jpeg, 800, 450)
            }

            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus {
                .authorizedAlways
            }

            func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
                .fullAccuracy
            }

            func currentLocation(
                desiredAccuracy: OpenClawLocationAccuracy,
                maxAgeMs: Int?,
                timeoutMs: Int?) async throws -> CLLocation
            {
                _ = desiredAccuracy
                _ = maxAgeMs
                _ = timeoutMs
                return CLLocation(latitude: 0, longitude: 0)
            }
        }

        let services = await MainActor.run { FakeMainActorServices() }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let params = MacNodeScreenSnapshotParams(
            screenIndex: 0,
            maxWidth: 800,
            quality: 0.5,
            format: .jpeg)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot",
                command: MacNodeScreenCommand.snapshot.rawValue,
                paramsJSON: json))
        #expect(response.ok == true)
        let payloadJSON = try #require(response.payloadJSON)

        struct Payload: Decodable {
            var format: String
            var base64: String
            var width: Int
            var height: Int
            var capturedAtMs: Int64
        }

        let payload = try JSONDecoder().decode(Payload.self, from: Data(payloadJSON.utf8))
        #expect(payload.format == "jpeg")
        #expect(payload.base64 == Data("ok".utf8).base64EncodedString())
        #expect(payload.width == 800)
        #expect(payload.height == 450)
        #expect(payload.capturedAtMs > 0)
        let snapshotCalledAtMs = await MainActor.run { services.snapshotCalledAtMs }
        #expect(snapshotCalledAtMs != nil)
        #expect(payload.capturedAtMs <= snapshotCalledAtMs!)
    }

    @Test func `handle invoke screen snapshot rejects malformed params`() async throws {
        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            var snapshotCallCount = 0

            func snapshotScreen(
                screenIndex: Int?,
                maxWidth: Int?,
                quality: Double?,
                format: OpenClawScreenSnapshotFormat?) async throws
                -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)
            {
                snapshotCallCount += 1
                _ = screenIndex
                _ = maxWidth
                _ = quality
                _ = format
                return (Data("ok".utf8), .jpeg, 10, 10)
            }

            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus { .authorizedAlways }
            func locationAccuracyAuthorization() -> CLAccuracyAuthorization { .fullAccuracy }
            func currentLocation(
                desiredAccuracy: OpenClawLocationAccuracy,
                maxAgeMs: Int?,
                timeoutMs: Int?) async throws -> CLLocation
            {
                _ = desiredAccuracy
                _ = maxAgeMs
                _ = timeoutMs
                return CLLocation(latitude: 0, longitude: 0)
            }
        }

        let services = await MainActor.run { FakeMainActorServices() }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-invalid",
                command: MacNodeScreenCommand.snapshot.rawValue,
                paramsJSON: "{\"screenIndex\":"))

        #expect(response.ok == false)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message == "INVALID_REQUEST: invalid screen snapshot params")
        let snapshotCallCount = await MainActor.run { services.snapshotCallCount }
        #expect(snapshotCallCount == 0)
    }

    @Test func `handle invoke screen snapshot sanitizes capture failures`() async throws {
        struct SensitiveError: LocalizedError {
            let detail: String
            var errorDescription: String? { detail }
        }

        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            func snapshotScreen(
                screenIndex: Int?,
                maxWidth: Int?,
                quality: Double?,
                format: OpenClawScreenSnapshotFormat?) async throws
                -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)
            {
                _ = screenIndex
                _ = maxWidth
                _ = quality
                _ = format
                throw SensitiveError(detail: "TCC_DENIED display-id=ABC123")
            }

            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus { .authorizedAlways }
            func locationAccuracyAuthorization() -> CLAccuracyAuthorization { .fullAccuracy }
            func currentLocation(
                desiredAccuracy: OpenClawLocationAccuracy,
                maxAgeMs: Int?,
                timeoutMs: Int?) async throws -> CLLocation
            {
                _ = desiredAccuracy
                _ = maxAgeMs
                _ = timeoutMs
                return CLLocation(latitude: 0, longitude: 0)
            }
        }

        let runtime = MacNodeRuntime(makeMainActorServices: { await MainActor.run { FakeMainActorServices() } })
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-error",
                command: MacNodeScreenCommand.snapshot.rawValue))

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message == "UNAVAILABLE: screen snapshot failed")
    }

    @Test func `handle invoke screen snapshot reports invalid screen index as INVALID_REQUEST`() async throws {
        // Out-of-range `screenIndex` is a caller input mistake caught by
        // `ScreenSnapshotService` before any capture attempt; this test locks
        // in that it surfaces as INVALID_REQUEST so callers get actionable
        // feedback instead of the generic capture-failure UNAVAILABLE.
        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            func snapshotScreen(
                screenIndex: Int?,
                maxWidth: Int?,
                quality: Double?,
                format: OpenClawScreenSnapshotFormat?) async throws
                -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)
            {
                _ = maxWidth
                _ = quality
                _ = format
                throw ScreenSnapshotService.ScreenSnapshotError.invalidScreenIndex(screenIndex ?? -1)
            }

            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus { .authorizedAlways }
            func locationAccuracyAuthorization() -> CLAccuracyAuthorization { .fullAccuracy }
            func currentLocation(
                desiredAccuracy: OpenClawLocationAccuracy,
                maxAgeMs: Int?,
                timeoutMs: Int?) async throws -> CLLocation
            {
                _ = desiredAccuracy
                _ = maxAgeMs
                _ = timeoutMs
                return CLLocation(latitude: 0, longitude: 0)
            }
        }

        let runtime = MacNodeRuntime(makeMainActorServices: { await MainActor.run { FakeMainActorServices() } })
        let params = MacNodeScreenSnapshotParams(screenIndex: 99)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-bad-index",
                command: MacNodeScreenCommand.snapshot.rawValue,
                paramsJSON: json))

        #expect(response.ok == false)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message == "INVALID_REQUEST: invalid screen index")
    }

    @Test func `handle invoke screen snapshot reports no displays as INVALID_REQUEST`() async throws {
        // `ScreenSnapshotService` throws `noDisplays` when no attached display
        // is visible to ScreenCaptureKit; this is also a request-shape problem
        // from the caller's perspective (there is nothing to snapshot on this
        // node), so it should surface as INVALID_REQUEST rather than the
        // sanitized UNAVAILABLE for true capture/encode internals.
        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            func snapshotScreen(
                screenIndex: Int?,
                maxWidth: Int?,
                quality: Double?,
                format: OpenClawScreenSnapshotFormat?) async throws
                -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)
            {
                _ = screenIndex
                _ = maxWidth
                _ = quality
                _ = format
                throw ScreenSnapshotService.ScreenSnapshotError.noDisplays
            }

            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus { .authorizedAlways }
            func locationAccuracyAuthorization() -> CLAccuracyAuthorization { .fullAccuracy }
            func currentLocation(
                desiredAccuracy: OpenClawLocationAccuracy,
                maxAgeMs: Int?,
                timeoutMs: Int?) async throws -> CLLocation
            {
                _ = desiredAccuracy
                _ = maxAgeMs
                _ = timeoutMs
                return CLLocation(latitude: 0, longitude: 0)
            }
        }

        let runtime = MacNodeRuntime(makeMainActorServices: { await MainActor.run { FakeMainActorServices() } })
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-no-displays",
                command: MacNodeScreenCommand.snapshot.rawValue))

        #expect(response.ok == false)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message == "INVALID_REQUEST: no displays available")
    }

    @Test func `handle invoke screen snapshot rejects oversized payloads`() async throws {
        let payloadSize = 19_660_800

        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            let payload: Data

            init(payloadSize: Int) {
                self.payload = Data(repeating: 0x41, count: payloadSize)
            }

            func snapshotScreen(
                screenIndex: Int?,
                maxWidth: Int?,
                quality: Double?,
                format: OpenClawScreenSnapshotFormat?) async throws
                -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)
            {
                _ = screenIndex
                _ = maxWidth
                _ = quality
                _ = format
                return (payload, .jpeg, 4000, 3000)
            }

            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus { .authorizedAlways }
            func locationAccuracyAuthorization() -> CLAccuracyAuthorization { .fullAccuracy }
            func currentLocation(
                desiredAccuracy: OpenClawLocationAccuracy,
                maxAgeMs: Int?,
                timeoutMs: Int?) async throws -> CLLocation
            {
                _ = desiredAccuracy
                _ = maxAgeMs
                _ = timeoutMs
                return CLLocation(latitude: 0, longitude: 0)
            }
        }

        let runtime = MacNodeRuntime(
            makeMainActorServices: { await MainActor.run { FakeMainActorServices(payloadSize: payloadSize) } })
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-too-large",
                command: MacNodeScreenCommand.snapshot.rawValue))

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(
            response.error?.message ==
                "UNAVAILABLE: screen snapshot payload too large; reduce maxWidth or use jpeg")
    }

    @Test
    func `handle invoke screen snapshot rejects frames whose serialized envelope exceeds transport ceiling`()
        async throws
    {
        // 12 MiB of 0xFF bytes base64-encodes to a string composed entirely
        // of `/` characters. This raw size comfortably passes the cheap
        // pre-capture lower bound (~19.66 MiB), but the inner JSON + the
        // outer `node.invoke.result` RequestFrame's JSON-string wrapping
        // balloon the serialized WebSocket frame well past the 25 MiB
        // transport ceiling — exactly the Codex "slash escape + envelope
        // overhead" case. The old raw-byte-only guard would have let this
        // through.
        let payloadSize = 12 * 1024 * 1024

        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            let payload: Data

            init(payloadSize: Int) {
                self.payload = Data(repeating: 0xFF, count: payloadSize)
            }

            func snapshotScreen(
                screenIndex: Int?,
                maxWidth: Int?,
                quality: Double?,
                format: OpenClawScreenSnapshotFormat?) async throws
                -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)
            {
                _ = screenIndex
                _ = maxWidth
                _ = quality
                _ = format
                return (payload, .png, 4000, 3000)
            }

            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus { .authorizedAlways }
            func locationAccuracyAuthorization() -> CLAccuracyAuthorization { .fullAccuracy }
            func currentLocation(
                desiredAccuracy: OpenClawLocationAccuracy,
                maxAgeMs: Int?,
                timeoutMs: Int?) async throws -> CLLocation
            {
                _ = desiredAccuracy
                _ = maxAgeMs
                _ = timeoutMs
                return CLLocation(latitude: 0, longitude: 0)
            }
        }

        let runtime = MacNodeRuntime(
            makeMainActorServices: { await MainActor.run { FakeMainActorServices(payloadSize: payloadSize) } })
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-frame-too-large",
                command: MacNodeScreenCommand.snapshot.rawValue))

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(
            response.error?.message ==
                "UNAVAILABLE: screen snapshot payload too large; reduce maxWidth or use jpeg")
    }

    @Test func `projected outer frame bytes bounds real serialized node invoke result frame`() throws {
        // Sanity check that `projectedOuterFrameBytes(...)` stays above the
        // real serialized size of a `node.invoke.result`-shaped frame that
        // wraps the inner payloadJSON as a JSON string. The inner payload is
        // deliberately seeded with `"`, `\`, and `/` bytes so the outer
        // encoder has to emit escapes — this is the regression case the
        // Codex P1/P2 comments flagged, where raw-byte ceilings alone miss
        // the JSON escape expansion applied at wrap time.
        let inner = #"{"format":"png","base64":"///AAA\/\\","width":1,"height":1,"capturedAtMs":0}"#
        let innerId = UUID().uuidString
        let outerNodeId = UUID().uuidString
        let projected = MacNodeRuntime.projectedOuterFrameBytes(
            forPayloadJSON: inner,
            requestId: innerId,
            nodeId: outerNodeId)

        struct Frame: Encodable {
            let type: String
            let id: String
            let method: String
            let params: Params
            struct Params: Encodable {
                let id: String
                let nodeId: String
                let ok: Bool
                let payloadJSON: String
            }
        }
        let frame = Frame(
            type: "req",
            id: UUID().uuidString,
            method: "node.invoke.result",
            params: Frame.Params(
                id: innerId,
                nodeId: outerNodeId,
                ok: true,
                payloadJSON: inner))
        let serialized = try JSONEncoder().encode(frame)

        #expect(projected >= serialized.count)
    }

    @Test
    func `projected outer frame bytes scales with dynamic id and nodeId lengths`() throws {
        // Codex P2 (2026-04-21) flagged that a fixed envelope reserve cannot
        // cover gateway node ids, which are only `NonEmptyString` on the wire
        // and so unbounded in length. This test pins the budgeting to the
        // dynamic id/nodeId surface: a much longer nodeId must move the
        // projection up by at least the extra UTF-8 byte count, and the
        // projection must still bound the real serialized frame for an
        // ASCII-only id pair. The inner payload is JSON-escape-free here so
        // the test isolates the id/nodeId contribution from payload escape
        // behavior already covered above.
        let inner = #"{"format":"png","width":1,"height":1,"capturedAtMs":0}"#
        let baseId = "req-1"
        let baseNodeId = "node-1"
        let longNodeId = String(repeating: "a", count: 100_000)

        let baseProjection = MacNodeRuntime.projectedOuterFrameBytes(
            forPayloadJSON: inner,
            requestId: baseId,
            nodeId: baseNodeId)
        let longProjection = MacNodeRuntime.projectedOuterFrameBytes(
            forPayloadJSON: inner,
            requestId: baseId,
            nodeId: longNodeId)
        let extraNodeIdBytes = longNodeId.utf8.count - baseNodeId.utf8.count
        #expect(longProjection - baseProjection >= extraNodeIdBytes)

        struct Frame: Encodable {
            let type: String
            let id: String
            let method: String
            let params: Params
            struct Params: Encodable {
                let id: String
                let nodeId: String
                let ok: Bool
                let payloadJSON: String
            }
        }
        let longFrame = Frame(
            type: "req",
            id: UUID().uuidString,
            method: "node.invoke.result",
            params: Frame.Params(
                id: baseId,
                nodeId: longNodeId,
                ok: true,
                payloadJSON: inner))
        let serializedLong = try JSONEncoder().encode(longFrame)
        #expect(longProjection >= serializedLong.count)

        // A near-25 MiB nodeId on its own must push the projection past the
        // gateway transport ceiling so the snapshot guard rejects the request
        // before it reaches the WebSocket. This is the false-accept case in
        // the original review: previously the projection only added a fixed
        // 1 KiB envelope reserve, so this would have been treated as in-budget.
        let oversizedNodeId = String(repeating: "n", count: 25 * 1024 * 1024)
        let oversizedProjection = MacNodeRuntime.projectedOuterFrameBytes(
            forPayloadJSON: "{}",
            requestId: baseId,
            nodeId: oversizedNodeId)
        #expect(oversizedProjection > 25 * 1024 * 1024)
    }

    @Test
    func `projected outer frame bytes accounts for control character escape expansion`() throws {
        // Codex P2 (2026-04-27) flagged that `jsonStringEscapeOverhead` only
        // counted `"`, `\`, and `/`, while `JSONEncoder` also expands C0
        // control characters in strings (the five short escapes `\b`, `\t`,
        // `\n`, `\f`, `\r` plus the six-byte `\u00XX` form for the rest).
        // `nodeId` is only constrained as `NonEmptyString` on the gateway
        // protocol side, so a control-character-heavy node id could otherwise
        // pass the projection guard and still serialize a frame above the
        // 25 MiB transport ceiling. This test pins both halves: the projection
        // must (a) bound the real serialized frame for an inner payload that
        // contains both short and `\uXXXX` control bytes alongside `"`/`\\`,
        // and (b) push past the 25 MiB ceiling on its own when a large
        // control-character `nodeId` would force a multiplicative blow-up at
        // wrap time.
        let inner = "{\"format\":\"png\",\"note\":\"\u{0001}\u{0002}\n\t\\\"raw\\\"\",\"width\":1,\"height\":1,\"capturedAtMs\":0}"
        let innerId = "req-control-char-1"
        let outerNodeId = "node-\u{0001}\u{0002}\u{0003}\n\t-id"

        let projected = MacNodeRuntime.projectedOuterFrameBytes(
            forPayloadJSON: inner,
            requestId: innerId,
            nodeId: outerNodeId)

        struct Frame: Encodable {
            let type: String
            let id: String
            let method: String
            let params: Params
            struct Params: Encodable {
                let id: String
                let nodeId: String
                let ok: Bool
                let payloadJSON: String
            }
        }
        let frame = Frame(
            type: "req",
            id: UUID().uuidString,
            method: "node.invoke.result",
            params: Frame.Params(
                id: innerId,
                nodeId: outerNodeId,
                ok: true,
                payloadJSON: inner))
        let serialized = try JSONEncoder().encode(frame)
        #expect(projected >= serialized.count)

        // A `nodeId` packed with `\uXXXX`-class control bytes (every source
        // byte expands to 6 wire bytes) only needs ~5 MiB of input to project
        // above the 25 MiB transport ceiling. Without the control-character
        // escape accounting added in this commit, the same input would have
        // been treated as ~5 MiB on the wire and falsely accepted.
        let controlByte: Character = "\u{0001}"
        let controlHeavyNodeId = String(repeating: controlByte, count: 5 * 1024 * 1024)
        let controlHeavyProjection = MacNodeRuntime.projectedOuterFrameBytes(
            forPayloadJSON: "{}",
            requestId: innerId,
            nodeId: controlHeavyNodeId)
        #expect(controlHeavyProjection > 25 * 1024 * 1024)
    }

    @Test func `handle invoke browser proxy uses injected request`() async {
        let runtime = MacNodeRuntime(browserProxyRequest: { paramsJSON in
            #expect(paramsJSON?.contains("/tabs") == true)
            return #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#
        })
        let paramsJSON = #"{"method":"GET","path":"/tabs","timeoutMs":2500}"#
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-browser",
                command: OpenClawBrowserCommand.proxy.rawValue,
                paramsJSON: paramsJSON))

        #expect(response.ok == true)
        #expect(response.payloadJSON == #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#)
    }

    @Test func `handle invoke browser proxy rejects disabled browser control`() async throws {
        let override = TestIsolation.tempConfigPath()
        try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            try JSONSerialization.data(withJSONObject: ["browser": ["enabled": false]])
                .write(to: URL(fileURLWithPath: override))

            let runtime = MacNodeRuntime(browserProxyRequest: { _ in
                Issue.record("browserProxyRequest should not run when browser control is disabled")
                return "{}"
            })
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(
                    id: "req-browser-disabled",
                    command: OpenClawBrowserCommand.proxy.rawValue,
                    paramsJSON: #"{"method":"GET","path":"/tabs"}"#))

            #expect(response.ok == false)
            #expect(response.error?.message.contains("BROWSER_DISABLED") == true)
        }
    }
}
