using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Application.Cron;

public sealed record SetCronJobEnabledCommand(string JobId, bool Enabled) : IRequest<ErrorOr<Success>>;

[UseCase("UC-056-cron-set-enabled")]
internal sealed class SetCronJobEnabledHandler : IRequestHandler<SetCronJobEnabledCommand, ErrorOr<Success>>
{
    private readonly IGatewayRpcChannel _rpc;

    public SetCronJobEnabledHandler(IGatewayRpcChannel rpc) => _rpc = rpc;

    public async Task<ErrorOr<Success>> Handle(SetCronJobEnabledCommand request, CancellationToken ct)
    {
        try
        {
            var patch = new Dictionary<string, object?> { ["enabled"] = request.Enabled };
            await _rpc.CronUpdateAsync(request.JobId, patch, ct);
            return Result.Success;
        }
        catch (Exception ex)
        {
            return Error.Failure("cron.update.failed", ex.Message);
        }
    }
}
