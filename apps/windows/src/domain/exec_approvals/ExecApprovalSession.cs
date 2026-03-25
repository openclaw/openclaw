using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.ExecApprovals;

/// <summary>
/// Represents a single command evaluation — from receipt to approval/denial/execution.
/// </summary>
public sealed class ExecApprovalSession : Entity<Guid>
{
    public ExecApprovalState State { get; private set; }
    public ExecApprovalConfig Config { get; }
    public string? PendingCommand { get; private set; }
    public string? CorrelationId { get; private set; }

    private ExecApprovalSession(ExecApprovalConfig config)
    {
        Guard.Against.Null(config, nameof(config));
        Id = Guid.NewGuid();
        Config = config;
        State = ExecApprovalState.Pending;
    }

    public static ExecApprovalSession Create(ExecApprovalConfig config) =>
        new(config);

    public void RequestApproval(string commandJson, string correlationId)
    {
        Guard.Against.NullOrWhiteSpace(commandJson, nameof(commandJson));
        Guard.Against.NullOrWhiteSpace(correlationId, nameof(correlationId));

        PendingCommand = commandJson;
        CorrelationId = correlationId;
        State = ExecApprovalState.Pending;
    }

    public ErrorOr<Success> Approve()
    {
        if (State != ExecApprovalState.Pending)
            return Error.Failure("EXEC-STATE", $"Cannot approve from state {State}");

        State = ExecApprovalState.Approved;
        return Result.Success;
    }

    public ErrorOr<Success> Deny()
    {
        if (State != ExecApprovalState.Pending)
            return Error.Failure("EXEC-STATE", $"Cannot deny from state {State}");

        State = ExecApprovalState.Denied;
        return Result.Success;
    }

    public ErrorOr<Success> BeginExecution()
    {
        // command only executes after approval — invariant
        if (State != ExecApprovalState.Approved)
            return Error.Failure("EXEC-STATE", "Command must be approved before execution");

        State = ExecApprovalState.Executing;
        return Result.Success;
    }

    public void MarkCompleted() => State = ExecApprovalState.Completed;
    public void MarkFailed() => State = ExecApprovalState.Failed;
}
