import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct ProcessArgumentsTests {
    @Test func `reads kernel identity with Unicode cwd and exact argv without environment entries`() throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent("Développement 👨‍👩‍👧‍👦\tline\n", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let input = Pipe()
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/bash")
        child.currentDirectoryURL = directory
        child.arguments = [
            "-c", "IFS= read -r fixture", "fixture", "Développement", "tab\tlabel", "line\nlabel",
            "family 👨‍👩‍👧‍👦", "", "after-empty",
        ]
        child.environment = ["PATH": "/usr/bin:/bin", "PROCESS_ARGUMENTS_ENV_SENTINEL": "must-not-be-returned"]
        child.standardInput = input.fileHandleForReading
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        defer {
            try? input.fileHandleForWriting.close()
            if child.isRunning { child.terminate() }
            child.waitUntilExit()
        }
        let result = try #require(try ProcessIdentity.read(pid: child.processIdentifier))
        #expect(result.pid == child.processIdentifier)
        #expect(result.parentPid == getpid())
        #expect(result.uid == geteuid())
        #expect(result.arguments == ["/bin/bash"] + (child.arguments ?? []))
        #expect(URL(fileURLWithPath: result.executablePath).resolvingSymlinksInPath() ==
            child.executableURL?.resolvingSymlinksInPath())
        var file = stat()
        #expect(stat(directory.path, &file) == 0)
        #expect(result.cwd.device == String(UInt32(bitPattern: file.st_dev)))
        #expect(result.cwd.inode == String(file.st_ino))
        var process = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, child.processIdentifier]
        #expect(sysctl(&mib, u_int(mib.count), &process, &size, nil, 0) == 0)
        #expect(result.startTime == "\(process.kp_proc.p_starttime.tv_sec):\(process.kp_proc.p_starttime.tv_usec)")
        #expect(try result.isCurrent())
    }
}
