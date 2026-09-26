import Darwin
import Foundation

struct ProcessArguments {
    let executablePath: String
    let arguments: [String]

    static func read(pid: Int32) -> Self? {
        guard pid > 0 else { return nil }
        var argMax: Int32 = 0
        var argMaxSize = MemoryLayout<Int32>.size
        var argMaxMib: [Int32] = [CTL_KERN, KERN_ARGMAX]
        guard sysctl(&argMaxMib, u_int(argMaxMib.count), &argMax, &argMaxSize, nil, 0) == 0,
              argMax > 0, argMax <= 4 * 1024 * 1024
        else { return nil }

        var buffer = [UInt8](repeating: 0, count: Int(argMax))
        defer {
            buffer.withUnsafeMutableBytes { bytes in
                _ = bytes.initializeMemory(as: UInt8.self, repeating: 0)
            }
        }
        var bufferSize = buffer.count
        var processMib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        let readSucceeded = buffer.withUnsafeMutableBytes { bytes in
            sysctl(&processMib, u_int(processMib.count), bytes.baseAddress, &bufferSize, nil, 0) == 0
        }
        guard readSucceeded, bufferSize >= MemoryLayout<Int32>.size, bufferSize <= buffer.count else { return nil }

        var argumentCount: Int32 = 0
        withUnsafeMutableBytes(of: &argumentCount) { destination in
            destination.copyBytes(from: buffer.prefix(destination.count))
        }
        guard argumentCount > 0, Int(argumentCount) <= bufferSize - MemoryLayout<Int32>.size else { return nil }
        var offset = MemoryLayout<Int32>.size
        func nextString() -> String? {
            guard offset < bufferSize, let end = buffer[offset..<bufferSize].firstIndex(of: 0),
                  let value = String(bytes: buffer[offset..<end], encoding: .utf8)
            else { return nil }
            offset = end + 1
            return value
        }
        guard let executablePath = nextString(), !executablePath.isEmpty else { return nil }
        while offset < bufferSize, buffer[offset] == 0 {
            offset += 1
        }

        // KERN_PROCARGS2 places the environment after argv. Stop at argc even when later arguments are empty.
        var arguments: [String] = []
        arguments.reserveCapacity(Int(argumentCount))
        for _ in 0..<argumentCount {
            guard let argument = nextString() else { return nil }
            arguments.append(argument)
        }
        return Self(executablePath: executablePath, arguments: arguments)
    }
}
