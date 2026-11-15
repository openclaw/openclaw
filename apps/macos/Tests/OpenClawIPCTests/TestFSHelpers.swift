import Foundation

func temporaryDirectoryForTests() -> URL {
    URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory(), isDirectory: true)
        .resolvingSymlinksInPath()
}

func makeTempDirForTests() throws -> URL {
    let base = temporaryDirectoryForTests()
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
