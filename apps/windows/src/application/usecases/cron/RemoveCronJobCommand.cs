using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Application.Cron;

public sealed record RemoveCronJobCommand(string JobId) : IRequest<ErrorOr<Success>>;

[UseCase("UC-056-cron-remove")]
internal sealed class RemoveCronJobHandler : IRequestHandler<RemoveCronJobCommand, ErrorOr<Success>>
{
    private readonly IGatewayRpcChannel _rpc;

    public RemoveCronJobHandler(IGatewayRpcChannel rpc) => _rpc = rpc;

    public async Task<ErrorOr<Success>> Handle(RemoveCronJobCommand request, CancellationToken ct)
    {
        try
        {
            await _rpc.CronRemoveAsync(request.JobId, ct);
            return Result.Success;
        }
        catch (Exception ex)
        {
            return Error.Failure("cron.remove.failed", ex.Message);
        }
    }
}
