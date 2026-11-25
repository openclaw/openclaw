import AppKit
import Darwin

/// ST-0002's stable ABI avoids importing Testing or invoking the bundle's CLI main.
private typealias TestEntryPoint = @convention(thin) @Sendable (
    UnsafeRawBufferPointer?,
    @escaping @Sendable (UnsafeRawBufferPointer) -> Void) async throws -> Bool

@MainActor
private final class NativeActionTestDelegate: NSObject, NSApplicationDelegate {
    let image: UnsafeMutableRawPointer
    let entryPoint: TestEntryPoint

    init(image: UnsafeMutableRawPointer, entryPoint: @escaping TestEntryPoint) {
        self.image = image
        self.entryPoint = entryPoint
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task {
            do {
                // The callback encoder precedes argv parsing. Only the file stream
                // is pinned to version 0; the launcher validates it after process exit.
                let passed = try await self.entryPoint(nil) { _ in }
                exit(passed ? EXIT_SUCCESS : EXIT_FAILURE)
            } catch {
                Self.fail("testing entry point threw")
            }
        }
    }

    static func fail(_ reason: String) -> Never {
        FileHandle.standardError.write(Data("[native-action-host] \(reason)\n".utf8))
        exit(EXIT_FAILURE)
    }
}

@main
@MainActor
private enum NativeActionTestHost {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 8,
              args[0] == "--test-bundle-path",
              args[2] == "--filter", args[3] == "NativeActionGatewayWireTests",
              args[4] == "--event-stream-version", args[5] == "0",
              args[6] == "--event-stream-output-path"
        else {
            NativeActionTestDelegate.fail("invalid native invocation")
        }
        // Dependency lookup must reach Testing.framework; RTLD_FIRST would hide it.
        guard let image = dlopen(args[1], RTLD_LAZY),
              let symbol = dlsym(image, "swt_abiv0_getEntryPoint")
        else {
            NativeActionTestDelegate.fail("testing entry point unavailable")
        }
        let getEntryPoint = unsafeBitCast(symbol, to: (@convention(c) () -> UnsafeRawPointer).self)
        let delegate = NativeActionTestDelegate(
            image: image, entryPoint: unsafeBitCast(getEntryPoint(), to: TestEntryPoint.self))
        let application = NSApplication.shared
        application.delegate = delegate
        // NSApplication's delegate is weak; both it and the loaded image must
        // outlive every awaited test and process-lifetime AppKit owner.
        withExtendedLifetime(delegate) {
            application.run()
        }
        NativeActionTestDelegate.fail("application loop returned before test completion")
    }
}
