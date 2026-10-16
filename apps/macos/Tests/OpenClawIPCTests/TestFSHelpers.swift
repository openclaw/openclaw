import Foundation

func testTemporaryDirectory() -> URL {
    // Foundation's Darwin temp directory can ignore the native sandbox launcher's TMPDIR.
    if let path = ProcessInfo.processInfo.environment["TMPDIR"] {
        return URL(fileURLWithPath: path, isDirectory: true)
    }
    return FileManager.default.temporaryDirectory
}

func makeTempDirForTests() throws -> URL {
    let base = testTemporaryDirectory()
    let dir = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

func makeExecutableForTests(at path: URL) throws {
    try FileManager().createDirectory(
        at: path.deletingLastPathComponent(),
        withIntermediateDirectories: true)
    FileManager().createFile(atPath: path.path, contents: Data("echo ok\n".utf8))
    try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: path.path)
}
