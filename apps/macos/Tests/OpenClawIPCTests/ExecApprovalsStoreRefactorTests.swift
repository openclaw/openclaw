import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsStoreRefactorTests {
    private func withTempStateDir(
        _ body: @escaping @Sendable (URL) async throws -> Void) async throws
    {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            try await body(stateDir)
        }
    }

    @Test
    func `ensure file skips rewrite when unchanged`() async throws {
        try await self.withTempStateDir { _ in
            _ = ExecApprovalsStore.ensureFile()
            let url = ExecApprovalsStore.fileURL()
            let firstIdentity = try Self.fileIdentity(at: url)

            _ = ExecApprovalsStore.ensureFile()
            let secondIdentity = try Self.fileIdentity(at: url)

            #expect(firstIdentity == secondIdentity)
        }
    }

    @Test
    func `decode preserves denylist security and rules`() async throws {
        let json = """
        {
          "version": 1,
          "managedDefaults": { "denylistVersion": 1 },
          "defaults": { "security": "denylist" },
          "agents": {
            "*": {
              "denylist": [
                {
                  "id": "custom",
                  "pattern": "curl",
                  "flags": "i"
                }
              ]
            }
          }
        }
        """
        let file = try JSONDecoder().decode(ExecApprovalsFile.self, from: Data(json.utf8))
        #expect(file.defaults?.security == .denylist)
        #expect(file.managedDefaults?.denylistVersion == 1)
        #expect(file.agents?["*"]?.denylist?.first?.id == "custom")
        #expect(file.agents?["*"]?.denylist?.first?.pattern == "curl")
    }

    @Test
    func `decode preserves legacy and malformed denylist entries`() async throws {
        let json = """
        {
          "version": 1,
          "socket": { "path": "/tmp/openclaw.sock", "token": "redacted" },
          "defaults": { "security": "denylist" },
          "agents": {
            "*": {
              "security": "denylist",
              "denylist": [
                "python\\\\s+-c",
                { "id": "bad", "pattern": 42, "flags": "i" },
                17
              ]
            }
          }
        }
        """
        let file = try JSONDecoder().decode(ExecApprovalsFile.self, from: Data(json.utf8))
        let denylist = try #require(file.agents?["*"]?.denylist)
        #expect(file.socket?.token == "redacted")
        #expect(file.defaults?.security == .denylist)
        #expect(file.agents?["*"]?.security == .denylist)
        #expect(denylist.map(\.pattern) == ["python\\s+-c", "", ""])
        #expect(denylist[1].id == "bad")
        #expect(denylist[1].flags == "i")
    }

    @Test
    func `decode preserves malformed denylist container for fail closed evaluation`() async throws {
        let json = """
        {
          "version": 1,
          "socket": { "path": "/tmp/openclaw.sock", "token": "redacted" },
          "agents": {
            "*": {
              "security": "denylist",
              "denylist": "not-an-array"
            }
          }
        }
        """
        let file = try JSONDecoder().decode(ExecApprovalsFile.self, from: Data(json.utf8))
        #expect(file.socket?.token == "redacted")
        #expect(file.agents?["*"]?.security == .denylist)
        #expect(file.agents?["*"]?.denylist?.map(\.pattern) == [""])
    }

    @Test
    func `new approvals file includes managed default denylist`() async throws {
        try await self.withTempStateDir { _ in
            let file = ExecApprovalsStore.ensureFile()
            #expect(file.managedDefaults?.denylistVersion == 1)
            #expect(file.agents?["*"]?.denylist?.contains { $0.id == "default-shell-network-fetch" } == true)
        }
    }

    @Test
    func `existing approvals file does not get default denylist injected`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try Data(#"{"version":1,"agents":{"main":{"security":"full"}}}"#.utf8).write(to: url)

            let file = ExecApprovalsStore.ensureFile()
            #expect(file.agents?["*"]?.denylist == nil)
            #expect(file.agents?["main"]?.security == .full)
        }
    }

    @Test
    func `enabling denylist mode seeds managed default denylist for upgraded files`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try Data(#"{"version":1,"agents":{"main":{"security":"full"}}}"#.utf8).write(to: url)

            ExecApprovalsStore.ensureManagedDefaultDenylistRules()

            let file = ExecApprovalsStore.ensureFile()
            #expect(file.managedDefaults?.denylistVersion == 1)
            #expect(file.agents?["*"]?.denylist?.contains { $0.id == "default-shell-network-fetch" } == true)
            #expect(file.agents?["main"]?.security == .full)
        }
    }

    @Test
    func `enabling denylist mode appends managed defaults to custom wildcard rules`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let json = [
                #"{"version":1,"agents":{"*":{"denylist":["#,
                #"{"id":"custom","pattern":"python\\s+-c"}]}}}"#,
            ].joined()
            try Data(json.utf8).write(to: url)

            ExecApprovalsStore.ensureManagedDefaultDenylistRules()

            let file = ExecApprovalsStore.ensureFile()
            let denylist = try #require(file.agents?["*"]?.denylist)
            #expect(denylist.contains { $0.id == "custom" && $0.pattern == #"python\s+-c"# })
            #expect(denylist.contains { $0.id == "default-shell-network-fetch" })
        }
    }

    @Test
    func `enabling denylist mode does not recreate removed managed defaults`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let json = [
                #"{"version":1,"managedDefaults":{"denylistVersion":1},"#,
                #""agents":{"*":{"denylist":[]}}}"#,
            ].joined()
            try Data(json.utf8).write(to: url)

            ExecApprovalsStore.ensureManagedDefaultDenylistRules()

            let file = ExecApprovalsStore.ensureFile()
            #expect(file.agents?["*"]?.denylist == nil)
            #expect(file.managedDefaults?.denylistVersion == 1)
        }
    }

    @Test
    func `ensure file preserves edited managed default denylist entries`() async throws {
        try await self.withTempStateDir { _ in
            let editedPattern = #"custom-fetch"#
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let json = """
            {"version":1,"managedDefaults":{"denylistVersion":1},"agents":{"*":{"denylist":[\
            {"id":"default-shell-network-fetch","pattern":"custom-fetch"}]}}}
            """
            try Data(json.utf8).write(to: url)

            let file = ExecApprovalsStore.ensureFile()
            let pattern = try #require(file.agents?["*"]?.denylist?.first?.pattern)
            #expect(pattern == editedPattern)
        }
    }

    @Test
    func `ensure file upgrades unedited managed default denylist entries`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let pattern = [
                #"(?:^|[\\s;&|()<>])(?:curl|wget)(?:\\.exe)?(?:$|[\\s;&|()<>])"#,
                #"[\\\\/](?:curl|wget)(?:\\.exe)?(?:$|[\\s;&|()<>])"#,
            ].joined(separator: "|")
            let json = """
            {"version":1,"managedDefaults":{"denylistVersion":1},"agents":{"*":{"denylist":[\
            {"id":"default-shell-network-fetch","pattern":"\(pattern)"}]}}}
            """
            try Data(json.utf8).write(to: url)

            let file = ExecApprovalsStore.ensureFile()
            let upgradedPattern = try #require(file.agents?["*"]?.denylist?.first?.pattern)
            #expect(upgradedPattern.contains(#"<>$]"#))
        }
    }

    @Test
    func `resolve preserves malformed denylist entries for fail closed evaluation`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try Data(#"{"version":1,"agents":{"*":{"denylist":[{"pattern":"   "}]}}}"#.utf8).write(to: url)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.denylist.first?.pattern == "   ")
        }
    }

    @Test
    func `approval evaluator clamps requested policy before denylist evaluation`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let approvalsJSON = """
                {
                  "version": 1,
                  "defaults": {
                    "security": "full",
                    "ask": "off"
                  },
                  "agents": {
                    "*": { "denylist": [{ "pattern": "curl" }] }
                  }
                }
                """
            try Data(approvalsJSON.utf8).write(to: url)

            let evaluation = await ExecApprovalEvaluator.evaluate(
                command: ["/bin/sh", "-c", "curl https://example.test/requested"],
                rawCommand: nil,
                cwd: nil,
                envOverrides: ["PATH": "/usr/bin:/bin"],
                agentId: "main",
                requestedSecurity: .denylist,
                requestedAsk: .always)
            #expect(evaluation.security == .denylist)
            #expect(evaluation.ask == .always)
            #expect(evaluation.denylistDenied)
        }
    }

    @Test
    func `approval evaluator does not let requested denylist weaken host allowlist`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let approvalsJSON = """
                {
                  "version": 1,
                  "defaults": {
                    "security": "allowlist",
                    "ask": "off"
                  },
                  "agents": {
                    "*": { "denylist": [{ "pattern": "curl" }] }
                  }
                }
                """
            try Data(approvalsJSON.utf8).write(to: url)

            let evaluation = await ExecApprovalEvaluator.evaluate(
                command: ["/bin/sh", "-c", "printf ok"],
                rawCommand: nil,
                cwd: nil,
                envOverrides: ["PATH": "/usr/bin:/bin"],
                agentId: "main",
                requestedSecurity: .denylist)
            #expect(evaluation.security == .allowlist)
            #expect(!evaluation.allowlistSatisfied)
        }
    }

    @Test
    func `approval evaluator keeps managed default deny rules out of allowlist mode`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let approvalsJSON = """
                {
                  "version": 1,
                  "managedDefaults": { "denylistVersion": 1 },
                  "defaults": {
                    "security": "allowlist",
                    "ask": "off"
                  },
                  "agents": {
                    "*": {
                      "allowlist": [{ "pattern": "*" }],
                      "denylist": [{
                        "id": "default-shell-network-fetch",
                        "pattern": "(?:^|[\\\\s;&|()<>])(?:curl|wget)(?:\\\\.exe)?(?:$|[\\\\s;&|()<>$])|[\\\\\\\\/](?:curl|wget)(?:\\\\.exe)?(?:$|[\\\\s;&|()<>$])",
                        "flags": "i"
                      }]
                    }
                  }
                }
                """
            try Data(approvalsJSON.utf8).write(to: url)

            let evaluation = await ExecApprovalEvaluator.evaluate(
                command: ["curl", "https://example.test/prompt"],
                rawCommand: nil,
                cwd: nil,
                envOverrides: ["PATH": "/usr/bin:/bin"],
                agentId: "main")
            #expect(evaluation.security == .allowlist)
            #expect(!evaluation.denylistDenied)
        }
    }

    @Test
    func `approval evaluator applies explicit deny rules in allowlist mode`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let approvalsJSON = """
                {
                  "version": 1,
                  "defaults": {
                    "security": "allowlist",
                    "ask": "off"
                  },
                  "agents": {
                    "*": {
                      "allowlist": [{ "pattern": "*" }],
                      "denylist": [{ "pattern": "curl" }]
                    }
                  }
                }
                """
            try Data(approvalsJSON.utf8).write(to: url)

            let evaluation = await ExecApprovalEvaluator.evaluate(
                command: ["curl", "https://example.test/prompt"],
                rawCommand: nil,
                cwd: nil,
                envOverrides: ["PATH": "/usr/bin:/bin"],
                agentId: "main")
            #expect(evaluation.security == .allowlist)
            #expect(evaluation.denylistDenied)
        }
    }

    @Test
    func `approval evaluator applies denylist fallback in full mode before prompt approval`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let approvalsJSON = """
                {
                  "version": 1,
                  "defaults": {
                    "security": "full",
                    "ask": "always",
                    "askFallback": "denylist"
                  },
                  "agents": {
                    "*": { "denylist": [{ "pattern": "curl" }] }
                  }
                }
                """
            try Data(approvalsJSON.utf8).write(to: url)

            let evaluation = await ExecApprovalEvaluator.evaluate(
                command: ["/bin/sh", "-c", "curl https://example.test/prompt"],
                rawCommand: nil,
                cwd: nil,
                envOverrides: ["PATH": "/usr/bin:/bin"],
                agentId: "main")
            #expect(evaluation.security == .full)
            #expect(evaluation.ask == .always)
            #expect(evaluation.denylistDenied)
        }
    }

    @Test
    func `approval evaluator ignores denylist fallback when full on miss does not prompt`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let approvalsJSON = """
                {
                  "version": 1,
                  "defaults": {
                    "security": "full",
                    "ask": "on-miss",
                    "askFallback": "denylist"
                  },
                  "agents": {
                    "*": { "denylist": [{ "pattern": "curl" }] }
                  }
                }
                """
            try Data(approvalsJSON.utf8).write(to: url)

            let evaluation = await ExecApprovalEvaluator.evaluate(
                command: ["/bin/sh", "-c", "curl https://example.test/prompt"],
                rawCommand: nil,
                cwd: nil,
                envOverrides: ["PATH": "/usr/bin:/bin"],
                agentId: "main")
            #expect(evaluation.security == .full)
            #expect(evaluation.ask == .onMiss)
            #expect(!evaluation.denylistDenied)
        }
    }

    @Test
    func `update allowlist accepts basename pattern`() async throws {
        try await self.withTempStateDir { _ in
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(pattern: "echo"),
                    ExecAllowlistEntry(pattern: "/bin/echo"),
                ])
            #expect(rejected.isEmpty)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.map(\.pattern) == ["echo", "/bin/echo"])
        }
    }

    @Test
    func `update allowlist migrates legacy pattern from resolved path`() async throws {
        try await self.withTempStateDir { _ in
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(
                        pattern: "echo",
                        lastUsedAt: nil,
                        lastUsedCommand: nil,
                        lastResolvedPath: " /usr/bin/echo "),
                ])
            #expect(rejected.isEmpty)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.map(\.pattern) == ["/usr/bin/echo"])
        }
    }

    @Test
    func `ensure file hardens state directory permissions`() async throws {
        try await self.withTempStateDir { stateDir in
            try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
            try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: stateDir.path)

            _ = ExecApprovalsStore.ensureFile()
            let attrs = try FileManager().attributesOfItem(atPath: stateDir.path)
            let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
            #expect(permissions & 0o777 == 0o700)
        }
    }

    private static func fileIdentity(at url: URL) throws -> Int {
        let attributes = try FileManager().attributesOfItem(atPath: url.path)
        guard let identifier = (attributes[.systemFileNumber] as? NSNumber)?.intValue else {
            struct MissingIdentifierError: Error {}
            throw MissingIdentifierError()
        }
        return identifier
    }
}
