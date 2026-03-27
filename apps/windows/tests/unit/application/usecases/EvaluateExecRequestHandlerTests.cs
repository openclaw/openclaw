using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.ExecApprovals;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Tests.Unit.Application.UseCases;

public sealed class EvaluateExecRequestHandlerTests
{
    private readonly IExecApprovalIpc _ipc = Substitute.For<IExecApprovalIpc>();
    private readonly IShellExecutor _shell = Substitute.For<IShellExecutor>();
    private readonly IExecApprovalsRepository _approvals = Substitute.For<IExecApprovalsRepository>();
    private readonly ISkillBinsCache _skillBins = Substitute.For<ISkillBinsCache>();
    private readonly IAuditLogger _audit = Substitute.For<IAuditLogger>();
    private readonly INodeRuntimeContext _nodeRuntime = Substitute.For<INodeRuntimeContext>();
    private readonly EvaluateExecRequestHandler _handler;

    // Full access, never ask — no IPC prompt required.
    private static readonly ExecApprovalsResolved AllowAllResolved = new()
    {
        PipePath = @"\\.\pipe\test",
        Token = "test-token",
        Defaults = new ExecApprovalsResolvedDefaults
            { Security = ExecSecurity.Full, Ask = ExecAsk.Off, AskFallback = ExecSecurity.Full, AutoAllowSkills = false },
        Agent = new ExecApprovalsResolvedDefaults
            { Security = ExecSecurity.Full, Ask = ExecAsk.Off, AskFallback = ExecSecurity.Full, AutoAllowSkills = false },
        Allowlist = [],
        File = new ExecApprovalsFile(),
    };

    // Handler expects {"command":["exe","args",...]} format (mirrors ExecRequestParser.swift)
    private static readonly string ValidCommandJson = """{"command":["ls","-la"]}""";

    public EvaluateExecRequestHandlerTests()
    {
        _nodeRuntime.MainSessionKey.Returns("main");

        _handler = new EvaluateExecRequestHandler(
            _ipc, _shell, _approvals, _skillBins, _audit, _nodeRuntime,
            NullLogger<EvaluateExecRequestHandler>.Instance);

        _approvals.ResolveAsync(Arg.Any<string?>(), Arg.Any<CancellationToken>())
            .Returns(AllowAllResolved);
        _approvals.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(ExecApprovalConfig.AllowAll()));
        _skillBins.CurrentBinsAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<IReadOnlySet<string>>(new HashSet<string>()));
    }

    [Fact]
    public async Task Handle_FullSecurityNoAsk_ExecutesWithoutIpc()
    {
        var expected = ShellCommandResult.Create(0, "output", "", 0, "ls").Value;
        // Arg.Any<string>() — executable may be resolved to full path on the test machine
        _shell.RunAsync(Arg.Any<string>(), Arg.Any<string[]>(), Arg.Any<int?>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<IReadOnlyDictionary<string, string>?>())
            .Returns(expected);

        var result = await _handler.Handle(
            new EvaluateExecRequestCommand(ValidCommandJson, "corr-001"), default);

        result.IsError.Should().BeFalse();
        await _ipc.DidNotReceive().RequestApprovalAsync(
            Arg.Any<NamedPipeFrame>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_ShellError_ReturnsError()
    {
        _shell.RunAsync(Arg.Any<string>(), Arg.Any<string[]>(), Arg.Any<int?>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<IReadOnlyDictionary<string, string>?>())
            .Returns(Error.Failure("SHELL", "command not found"));

        var result = await _handler.Handle(
            new EvaluateExecRequestCommand(ValidCommandJson, "corr-002"), default);

        result.IsError.Should().BeTrue();
    }

    [Fact]
    public async Task Handle_AuditsExecution()
    {
        _shell.RunAsync(Arg.Any<string>(), Arg.Any<string[]>(), Arg.Any<int?>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<IReadOnlyDictionary<string, string>?>())
            .Returns(ShellCommandResult.Create(0, "ok", "", 0, "ls").Value);

        await _handler.Handle(new EvaluateExecRequestCommand(ValidCommandJson, "c1"), default);

        // The handler resolves the executable path (e.g. to Git's ls.exe on Windows).
        // All args must use matchers when mixing concrete values with Arg.Any (NSubstitute rule).
        await _audit.Received(1).LogAsync(
            Arg.Is<string>(s => s == "system.run"),
            Arg.Any<string>(),
            Arg.Is(true),
            Arg.Is<string?>(x => x == null),
            Arg.Any<CancellationToken>());
    }

    // ── Exec event emission — mirrors MacNodeRuntime.handleSystemRun emit* calls ──

    [Fact]
    public async Task Handle_SuccessfulRun_EmitsStartedThenFinished()
    {
        _shell.RunAsync(Arg.Any<string>(), Arg.Any<string[]>(), Arg.Any<int?>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<IReadOnlyDictionary<string, string>?>())
            .Returns(ShellCommandResult.Create(0, "hello", "", 10, "ls").Value);

        await _handler.Handle(new EvaluateExecRequestCommand(ValidCommandJson, "evt-001"), default);

        _nodeRuntime.Received(1).EmitExecEvent(
            Arg.Is("exec.started"), Arg.Any<ExecEventPayload>());
        _nodeRuntime.Received(1).EmitExecEvent(
            Arg.Is("exec.finished"),
            Arg.Is<ExecEventPayload>(p => p.Success == true && p.TimedOut == false));
    }

    [Fact]
    public async Task Handle_SecurityDeny_EmitsDeniedWithReason()
    {
        var denyResolved = AllowAllResolved with
        {
            Agent = new ExecApprovalsResolvedDefaults
                { Security = ExecSecurity.Deny, Ask = ExecAsk.Off, AskFallback = ExecSecurity.Deny, AutoAllowSkills = false },
        };
        _approvals.ResolveAsync(Arg.Any<string?>(), Arg.Any<CancellationToken>())
            .Returns(denyResolved);

        await _handler.Handle(new EvaluateExecRequestCommand(ValidCommandJson, "evt-002"), default);

        _nodeRuntime.Received(1).EmitExecEvent(
            Arg.Is("exec.denied"),
            Arg.Is<ExecEventPayload>(p => p.Reason == "security=deny"));
    }

    [Fact]
    public async Task Handle_UserDenied_EmitsDeniedWithReason()
    {
        var askResolved = AllowAllResolved with
        {
            Agent = new ExecApprovalsResolvedDefaults
                { Security = ExecSecurity.Full, Ask = ExecAsk.Always, AskFallback = ExecSecurity.Full, AutoAllowSkills = false },
        };
        _approvals.ResolveAsync(Arg.Any<string?>(), Arg.Any<CancellationToken>())
            .Returns(askResolved);
        _ipc.RequestApprovalAsync(Arg.Any<NamedPipeFrame>(), Arg.Any<CancellationToken>())
            .Returns(false); // user denied

        await _handler.Handle(new EvaluateExecRequestCommand(ValidCommandJson, "evt-003"), default);

        _nodeRuntime.Received(1).EmitExecEvent(
            Arg.Is("exec.denied"),
            Arg.Is<ExecEventPayload>(p => p.Reason == "user-denied"));
    }

    [Fact]
    public async Task Handle_TimeoutMs_PassedToShell()
    {
        var json = """{"command":["sleep","10"],"timeoutMs":500}""";
        _shell.RunAsync(Arg.Any<string>(), Arg.Any<string[]>(), Arg.Any<int?>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<IReadOnlyDictionary<string, string>?>())
            .Returns(ShellCommandResult.Create(0, "", "", 10, "sleep").Value);

        await _handler.Handle(new EvaluateExecRequestCommand(json, "timeout-001"), default);

        await _shell.Received(1).RunAsync(
            Arg.Any<string>(),
            Arg.Any<string[]>(),
            Arg.Is<int?>(t => t == 500),
            Arg.Any<CancellationToken>(),
            Arg.Any<string?>(),
            Arg.Any<IReadOnlyDictionary<string, string>?>());
    }

    [Fact]
    public async Task Handle_SessionKeyFromParams_UsedInEvent()
    {
        var json = """{"command":["ls"],"sessionKey":"session-abc"}""";
        _shell.RunAsync(Arg.Any<string>(), Arg.Any<string[]>(), Arg.Any<int?>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<IReadOnlyDictionary<string, string>?>())
            .Returns(ShellCommandResult.Create(0, "", "", 5, "ls").Value);

        await _handler.Handle(new EvaluateExecRequestCommand(json, "sk-001"), default);

        _nodeRuntime.Received().EmitExecEvent(
            Arg.Any<string>(),
            Arg.Is<ExecEventPayload>(p => p.SessionKey == "session-abc"));
    }

    [Fact]
    public async Task Handle_NoSessionKeyInParams_FallsBackToMainSessionKey()
    {
        _nodeRuntime.MainSessionKey.Returns("main-session");
        _shell.RunAsync(Arg.Any<string>(), Arg.Any<string[]>(), Arg.Any<int?>(), Arg.Any<CancellationToken>(), Arg.Any<string?>(), Arg.Any<IReadOnlyDictionary<string, string>?>())
            .Returns(ShellCommandResult.Create(0, "", "", 5, "ls").Value);

        await _handler.Handle(new EvaluateExecRequestCommand(ValidCommandJson, "sk-002"), default);

        _nodeRuntime.Received().EmitExecEvent(
            Arg.Any<string>(),
            Arg.Is<ExecEventPayload>(p => p.SessionKey == "main-session"));
    }

    [Fact]
    public async Task Handle_AllowlistMiss_EmitsDeniedWithReason()
    {
        // security=Allowlist, ask=Off, no entries → allowlist miss deny from Evaluate()
        var allowlistResolved = AllowAllResolved with
        {
            Agent = new ExecApprovalsResolvedDefaults
                { Security = ExecSecurity.Allowlist, Ask = ExecAsk.Off, AskFallback = ExecSecurity.Allowlist, AutoAllowSkills = false },
            Allowlist = [],
        };
        _approvals.ResolveAsync(Arg.Any<string?>(), Arg.Any<CancellationToken>())
            .Returns(allowlistResolved);

        var result = await _handler.Handle(new EvaluateExecRequestCommand(ValidCommandJson, "am-001"), default);

        result.IsError.Should().BeTrue();
        _nodeRuntime.Received(1).EmitExecEvent(
            Arg.Is("exec.denied"),
            Arg.Is<ExecEventPayload>(p => p.Reason == "allowlist-miss"));
    }
}
