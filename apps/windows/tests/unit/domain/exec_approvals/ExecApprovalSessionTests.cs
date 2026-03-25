namespace OpenClawWindows.Tests.Unit.Domain.ExecApprovals;

public sealed class ExecApprovalSessionTests
{
    // ── Create ──────────────────────────────────────────────────────────────

    [Fact]
    public void Create_WithConfig_InitialStateIsPending()
    {
        var session = ExecApprovalSession.Create(ExecApprovalConfig.AllowAll());

        session.State.Should().Be(ExecApprovalState.Pending);
        session.PendingCommand.Should().BeNull();
    }

    // ── RequestApproval ─────────────────────────────────────────────────────

    [Fact]
    public void RequestApproval_SetsCommandAndCorrelationId()
    {
        var session = ExecApprovalSession.Create(ExecApprovalConfig.AllowAll());

        session.RequestApproval("{\"executable\":\"ls\"}", "corr-001");

        session.PendingCommand.Should().Be("{\"executable\":\"ls\"}");
        session.CorrelationId.Should().Be("corr-001");
    }

    // ── Approve / Deny ──────────────────────────────────────────────────────

    [Fact]
    public void Approve_FromPending_Succeeds()
    {
        var session = PendingSession();

        var result = session.Approve();

        result.IsError.Should().BeFalse();
        session.State.Should().Be(ExecApprovalState.Approved);
    }

    [Fact]
    public void Deny_FromPending_Succeeds()
    {
        var session = PendingSession();

        var result = session.Deny();

        result.IsError.Should().BeFalse();
        session.State.Should().Be(ExecApprovalState.Denied);
    }

    [Fact]
    public void Approve_FromDenied_ReturnsError()
    {
        var session = PendingSession();
        session.Deny();

        var result = session.Approve();

        result.IsError.Should().BeTrue();
    }

    // ── BeginExecution ──────────────────────────────────────────────────────

    [Fact]
    public void BeginExecution_AfterApprove_Succeeds()
    {
        var session = PendingSession();
        session.Approve();

        var result = session.BeginExecution();

        result.IsError.Should().BeFalse();
        session.State.Should().Be(ExecApprovalState.Executing);
    }

    [Fact]
    public void BeginExecution_WithoutApprove_ReturnsError()
    {
        // command must be approved before execution — invariant from ExecApprovalEvaluation.swift
        var session = PendingSession();

        var result = session.BeginExecution();

        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("EXEC-STATE");
    }

    // ── MarkCompleted / MarkFailed ──────────────────────────────────────────

    [Fact]
    public void MarkCompleted_TransitionsToCompleted()
    {
        var session = PendingSession();
        session.Approve();
        session.BeginExecution();

        session.MarkCompleted();

        session.State.Should().Be(ExecApprovalState.Completed);
    }

    [Fact]
    public void MarkFailed_TransitionsToFailed()
    {
        var session = PendingSession();
        session.Approve();
        session.BeginExecution();

        session.MarkFailed();

        session.State.Should().Be(ExecApprovalState.Failed);
    }

    // ── ExecApprovalConfig ──────────────────────────────────────────────────

    [Fact]
    public void ExecApprovalConfig_AllowAll_DoesNotRequireApproval()
    {
        var config = ExecApprovalConfig.AllowAll();
        config.RequireApproval.Should().BeFalse();
    }

    [Fact]
    public void ExecApprovalConfig_DenyAll_RequiresApproval()
    {
        var config = ExecApprovalConfig.DenyAll();
        config.RequireApproval.Should().BeTrue();
    }

    [Fact]
    public void ExecApprovalConfig_Create_NegativeMaxOutput_ReturnsError()
    {
        var result = ExecApprovalConfig.Create(false, [], [], [], -1);
        result.IsError.Should().BeTrue();
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private static ExecApprovalSession PendingSession()
    {
        var session = ExecApprovalSession.Create(ExecApprovalConfig.AllowAll());
        session.RequestApproval("{\"executable\":\"ls\"}", "corr-1");
        return session;
    }
}
