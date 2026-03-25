using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Application.Cron;

public sealed record RunCronJobCommand(string JobId, bool Force = true) : IRequest<ErrorOr<Success>>;

[UseCase("UC-056-cron-run")]
internal sealed class RunCronJobHandler : IRequestHandler<RunCronJobCommand, ErrorOr<Success>>
{
    private readonly IGatewayRpcChannel _rpc;

    public RunCronJobHandler(IGatewayRpcChannel rpc) => _rpc = rpc;

    public async Task<ErrorOr<Success>> Handle(RunCronJobCommand request, CancellationToken ct)
    {
        try
        {
            await _rpc.CronRunAsync(request.JobId, request.Force, ct);
            return Result.Success;
        }
        catch (Exception ex)
        {
            return Error.Failure("cron.run.failed", ex.Message);
        }
    }
}
