import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct ExecApprovalPolicySnapshotTests {
    @Test
    func `allow always source promotion is additive`() {
        let expected = Self.snapshot(source: nil)
        let current = Self.snapshot(source: "allow-always")

        #expect(expected.isCurrent(current))
    }

    @Test
    func `allow always source downgrade is rejected`() {
        let expected = Self.snapshot(source: "allow-always")
        let current = Self.snapshot(source: nil)

        #expect(!expected.isCurrent(current))
    }

    @Test
    func `portable snapshot import preserves canonical policy semantics`() {
        let snapshot = ExecApprovalPolicySnapshot(
            security: .allowlist,
            ask: .onMiss,
            askFallback: .deny,
            autoAllowSkills: true,
            allowlist: [
                ExecAllowlistEntry(pattern: "/usr/bin/tool", source: "legacy"),
                ExecAllowlistEntry(
                    pattern: "/usr/bin/tool",
                    source: "allow-always",
                    argPattern: "^ok$"),
            ])

        let portable = OpenClawSystemRunApprovalPolicySnapshot(
            security: .allowlist,
            ask: .onMiss,
            askFallback: .deny,
            autoAllowSkills: true,
            allowlistRules: [
                OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/usr/bin/tool"),
                OpenClawSystemRunApprovalPolicySnapshot.Rule(
                    pattern: "/usr/bin/tool",
                    argPattern: "^ok$",
                    source: .allowAlways),
            ])
        #expect(snapshot == ExecApprovalPolicySnapshot(portable: portable))
    }

    @Test
    func `portable snapshot decode deduplicates and sorts rules by utf8 bytes`() throws {
        let data = Data(#"""
        {
          "security": "allowlist",
          "ask": "on-miss",
          "askFallback": "deny",
          "autoAllowSkills": false,
          "allowlistRules": [
            {"pattern": "/ä"},
            {"pattern": "/A", "source": "allow-always"},
            {"pattern": "/", "argPattern": "é"},
            {"pattern": "/"},
            {"pattern": "/", "argPattern": "A"},
            {"pattern": "/"},
            {"pattern": "/A"},
            {"pattern": "/é"},
            {"pattern": "/e\u0301"}
          ]
        }
        """#.utf8)

        let portable = try JSONDecoder().decode(
            OpenClawSystemRunApprovalPolicySnapshot.self,
            from: data)

        #expect(portable.allowlistRules == [
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/"),
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/", argPattern: "A"),
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/", argPattern: "é"),
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/A"),
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/A", source: .allowAlways),
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/e\u{0301}"),
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/ä"),
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/é"),
        ])
        #expect(ExecApprovalPolicySnapshot(portable: portable) == ExecApprovalPolicySnapshot(
            security: .allowlist,
            ask: .onMiss,
            askFallback: .deny,
            autoAllowSkills: false,
            allowlist: [
                ExecAllowlistEntry(pattern: "/"),
                ExecAllowlistEntry(pattern: "/", argPattern: "A"),
                ExecAllowlistEntry(pattern: "/", argPattern: "é"),
                ExecAllowlistEntry(pattern: "/A"),
                ExecAllowlistEntry(pattern: "/A", source: "allow-always"),
                ExecAllowlistEntry(pattern: "/e\u{0301}"),
                ExecAllowlistEntry(pattern: "/ä"),
                ExecAllowlistEntry(pattern: "/é"),
            ]))
    }

    private static func snapshot(source: String?) -> ExecApprovalPolicySnapshot {
        ExecApprovalPolicySnapshot(
            security: .allowlist,
            ask: .always,
            askFallback: .deny,
            autoAllowSkills: false,
            allowlist: [ExecAllowlistEntry(
                pattern: "/usr/bin/printf",
                source: source,
                argPattern: "^ok$")])
    }
}
