import Testing
@testable import OpenClaw

struct ExecDenylistEvaluatorTests {
    private let defaultDenylist = [
        ExecDenylistEntry(
            id: "default-shell-network-fetch",
            pattern: [
                #"(?:^|[\s;&|()<>])(?:curl|wget)(?:\.exe)?(?:$|[\s;&|()<>$])"#,
                #"[\\/](?:curl|wget)(?:\.exe)?(?:$|[\s;&|()<>$])"#,
            ].joined(separator: "|"),
            flags: "i"),
    ]

    @Test func `denies raw command matches`() {
        #expect(ExecDenylistEvaluator.denied(
            command: ["/bin/sh", "-c", "curl https://example.test/prompt"],
            displayCommand: "/bin/sh -c \"curl https://example.test/prompt\"",
            env: [:],
            denylist: self.defaultDenylist))
    }

    @Test func `denies uppercase command matches`() {
        #expect(ExecDenylistEvaluator.denied(
            command: ["/bin/sh", "-c", "CURL https://example.test/prompt"],
            displayCommand: "/bin/sh -c \"CURL https://example.test/prompt\"",
            env: [:],
            denylist: self.defaultDenylist))
    }

    @Test func `denies default network fetch commands behind command carriers`() {
        for (command, displayCommand) in [
            (["/usr/bin/env", "FOO=bar", "curl", "https://example.test/prompt"],
             "env FOO=bar curl https://example.test/prompt"),
            (["/usr/bin/sudo", "curl", "https://example.test/prompt"],
             "sudo curl https://example.test/prompt"),
            (["/bin/sh", "-c", "command curl https://example.test/prompt"],
             "sh -c 'command curl https://example.test/prompt'"),
            (["/usr/bin/env", "-S", "curl https://example.test/prompt"],
             "env -S 'curl https://example.test/prompt'"),
            (["/usr/bin/env", "-iS", "curl https://example.test/prompt"],
             "env -iS 'curl https://example.test/prompt'"),
            (["/usr/bin/env", "-iScurl https://example.test/prompt"],
             "env -iScurl https://example.test/prompt"),
        ] {
            #expect(ExecDenylistEvaluator.denied(
                command: command,
                displayCommand: displayCommand,
                env: [:],
                denylist: self.defaultDenylist))
        }
    }

    @Test func `default denylist does not fail closed on innocent commands`() {
        #expect(!ExecDenylistEvaluator.denied(
            command: ["/usr/bin/git", "status"],
            displayCommand: "/usr/bin/git status",
            env: [:],
            denylist: self.defaultDenylist))
    }

    @Test func `custom denylist rules remain case sensitive without i flag`() {
        #expect(!ExecDenylistEvaluator.denied(
            command: ["/usr/bin/printf", "PROD"],
            displayCommand: "/usr/bin/printf PROD",
            env: [:],
            denylist: [ExecDenylistEntry(id: "rule", pattern: "prod", flags: nil)]))
        #expect(ExecDenylistEvaluator.denied(
            command: ["/usr/bin/printf", "PROD"],
            displayCommand: "/usr/bin/printf PROD",
            env: [:],
            denylist: [ExecDenylistEntry(id: "rule", pattern: "prod", flags: "i")]))
    }

    @Test func `denies shell parameter expansion separators`() {
        #expect(ExecDenylistEvaluator.denied(
            command: ["/bin/sh", "-c", "curl${IFS}https://example.test"],
            displayCommand: #"/bin/sh -c 'curl${IFS}https://example.test'"#,
            env: [:],
            denylist: self.defaultDenylist))
    }

    @Test func `denies dequoted shell executable payload matches`() {
        #expect(ExecDenylistEvaluator.denied(
            command: ["/bin/sh", "-c", #"cu""rl https://example.test/prompt"#],
            displayCommand: #"/bin/sh -c 'cu""rl https://example.test/prompt'"#,
            env: [:],
            denylist: self.defaultDenylist))
    }

    @Test func `denies inline env assignment payload matches`() {
        #expect(ExecDenylistEvaluator.denied(
            command: ["env", "PAYLOAD=curl https://example.test/prompt", "sh", "-c", "$PAYLOAD"],
            displayCommand: #"env PAYLOAD="curl https://example.test/prompt" sh -c "$PAYLOAD""#,
            env: [:],
            denylist: self.defaultDenylist))
    }

    @Test func `denies partial env expansion payload matches`() {
        #expect(ExecDenylistEvaluator.denied(
            command: ["X=u", "sh", "-c", "c${X}rl https://example.test/prompt"],
            displayCommand: #"X=u sh -c 'c${X}rl https://example.test/prompt'"#,
            env: [:],
            denylist: self.defaultDenylist))
    }

    @Test func `denies env var payload matches`() {
        for command in [
            "/bin/sh -lc \"$PAYLOAD\"",
            #"pwsh -Command "$env:payload""#,
            #"cmd /c "%payload%""#,
        ] {
            #expect(ExecDenylistEvaluator.denied(
                command: [command],
                displayCommand: command,
                env: ["PAYLOAD": "curl https://example.test/prompt"],
                denylist: self.defaultDenylist))
        }
    }

    @Test func `invalid denylist rules fail closed`() {
        #expect(ExecDenylistEvaluator.denied(
            command: ["/usr/bin/printf", "ok"],
            displayCommand: "/usr/bin/printf ok",
            env: [:],
            denylist: [ExecDenylistEntry(id: "bad", pattern: "curl", flags: "g")]))
    }

    @Test func `unsafe denylist regexes fail closed`() {
        #expect(ExecDenylistEvaluator.denied(
            command: ["/usr/bin/printf", String(repeating: "a", count: 512) + "b"],
            displayCommand: "/usr/bin/printf \(String(repeating: "a", count: 512))b",
            env: [:],
            denylist: [ExecDenylistEntry(id: "unsafe", pattern: "(a+)+", flags: nil)]))
    }

    @Test func `ambiguous repeated alternation regexes fail closed`() {
        #expect(ExecDenylistEvaluator.denied(
            command: ["/usr/bin/printf", String(repeating: "a", count: 512) + "b"],
            displayCommand: "/usr/bin/printf \(String(repeating: "a", count: 512))b",
            env: [:],
            denylist: [ExecDenylistEntry(id: "unsafe", pattern: "(a|aa)+$", flags: nil)]))
    }

    @Test func `bounded repeated alternation regexes do not fail closed`() {
        #expect(!ExecDenylistEvaluator.denied(
            command: ["/usr/bin/git", "status"],
            displayCommand: "/usr/bin/git status",
            env: [:],
            denylist: [ExecDenylistEntry(id: "bounded", pattern: "(sh|bash){1,2}", flags: nil)]))
    }

    @Test func `total oversized candidate input fails closed`() {
        let argument = String(repeating: "a", count: 4_096)
        #expect(ExecDenylistEvaluator.denied(
            command: Array(repeating: argument, count: 80),
            displayCommand: argument,
            env: [:],
            denylist: [ExecDenylistEntry(id: "rule", pattern: "curl", flags: nil)]))
    }
}
