import Foundation
import Testing
@testable import OpenClaw

struct ExecApprovalHelpersTests {
    @Test func `allowlist pattern prefers resolution`() {
        let resolved = ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
        #expect(ExecApprovalHelpers.allowlistPattern(command: ["rg"], resolution: resolved) == resolved.resolvedPath)

        let rawOnly = ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: nil,
            executableName: "rg",
            cwd: nil)
        #expect(ExecApprovalHelpers.allowlistPattern(command: ["rg"], resolution: rawOnly) == "rg")
        #expect(ExecApprovalHelpers.allowlistPattern(command: ["rg"], resolution: nil) == "rg")
        #expect(ExecApprovalHelpers.allowlistPattern(command: [], resolution: nil) == nil)
    }

    @Test func `allowlist matching trims patterns and rejects blank entries`() {
        let resolution = ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
        let valid = ExecAllowlistEntry(pattern: "  rg\n")
        #expect(ExecAllowlistMatcher.match(entries: [valid], resolution: resolution) == valid)
        #expect(ExecAllowlistMatcher.match(
            entries: [ExecAllowlistEntry(pattern: " \n ")], resolution: resolution) == nil)
    }

    @Test func `requires ask matches policy`() {
        let entry = ExecAllowlistEntry(pattern: "/bin/ls", lastUsedAt: nil, lastUsedCommand: nil, lastResolvedPath: nil)
        #expect(ExecApprovalHelpers.requiresAsk(
            ask: .always,
            security: .deny,
            allowlistMatch: nil,
            skillAllow: false))
        #expect(ExecApprovalHelpers.requiresAsk(
            ask: .onMiss,
            security: .allowlist,
            allowlistMatch: nil,
            skillAllow: false))
        #expect(!ExecApprovalHelpers.requiresAsk(
            ask: .onMiss,
            security: .allowlist,
            allowlistMatch: entry,
            skillAllow: false))
        #expect(!ExecApprovalHelpers.requiresAsk(
            ask: .onMiss,
            security: .allowlist,
            allowlistMatch: nil,
            skillAllow: true))
        #expect(!ExecApprovalHelpers.requiresAsk(
            ask: .off,
            security: .allowlist,
            allowlistMatch: nil,
            skillAllow: false))
    }
}
