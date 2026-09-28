import Darwin
import Foundation

struct ProcessIdentity: Encodable {
    struct Birth: Equatable {
        let pid: Int32
        let parentPid: Int32
        let uid: UInt32
        let startTime: String
    }

    struct Directory: Encodable {
        let device: String
        let inode: String
    }

    enum ReadError: LocalizedError {
        case unavailable
        case changed

        var errorDescription: String? {
            switch self {
            case .unavailable: "Could not read complete native process identity"
            case .changed: "Native process identity changed during inspection"
            }
        }
    }

    let pid: Int32
    let parentPid: Int32
    let uid: UInt32
    let startTime: String
    let executablePath: String
    let arguments: [String]
    let cwd: Directory

    /// Nil means the process is gone; denied or incomplete inspection throws instead.
    static func birth(pid: Int32) throws -> Birth? {
        guard pid > 0 else { throw ReadError.unavailable }
        var info = proc_bsdinfo()
        let count = withUnsafeMutableBytes(of: &info) { bytes in
            proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, bytes.baseAddress, Int32(bytes.count))
        }
        guard Int(count) == MemoryLayout<proc_bsdinfo>.size else {
            if count <= 0, errno == ESRCH { return nil }
            throw ReadError.unavailable
        }
        guard info.pbi_pid == UInt32(pid), let parentPid = Int32(exactly: info.pbi_ppid),
              info.pbi_start_tvusec < 1_000_000
        else { throw ReadError.unavailable }
        if info.pbi_status == UInt32(SZOMB) { return nil }
        return Birth(
            pid: pid,
            parentPid: parentPid,
            uid: info.pbi_uid,
            startTime: "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)")
    }

    static func read(pid: Int32) throws -> Self? {
        guard let before = try self.birth(pid: pid) else { return nil }
        guard let arguments = ProcessArguments.read(pid: pid) else { throw ReadError.unavailable }
        var vnode = proc_vnodepathinfo()
        let count = withUnsafeMutableBytes(of: &vnode) { bytes in
            proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, bytes.baseAddress, Int32(bytes.count))
        }
        guard Int(count) == MemoryLayout<proc_vnodepathinfo>.size else { throw ReadError.unavailable }
        guard let after = try self.birth(pid: pid) else { return nil }
        guard before == after else { throw ReadError.changed }
        return Self(
            pid: pid,
            parentPid: before.parentPid,
            uid: before.uid,
            startTime: before.startTime,
            executablePath: arguments.executablePath,
            arguments: arguments.arguments,
            cwd: Directory(
                device: String(vnode.pvi_cdir.vip_vi.vi_stat.vst_dev),
                inode: String(vnode.pvi_cdir.vip_vi.vi_stat.vst_ino)))
    }

    func isCurrent() throws -> Bool {
        try Self.birth(pid: self.pid) == Birth(
            pid: self.pid, parentPid: self.parentPid, uid: self.uid, startTime: self.startTime)
    }
}
