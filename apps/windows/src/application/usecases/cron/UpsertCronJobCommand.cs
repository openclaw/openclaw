using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Application.Cron;

// update when id is provided, add when id is null.
public sealed record UpsertCronJobCommand(
    string? JobId,
    Dictionary<string, object?> Payload) : IRequest<ErrorOr<Success>>;

[UseCase("UC-056-cron-upsert")]
internal sealed class UpsertCronJobHandler : IRequestHandler<UpsertCronJobCommand, ErrorOr<Success>>
{
    private readonly IGatewayRpcChannel _rpc;

    public UpsertCronJobHandler(IGatewayRpcChannel rpc) => _rpc = rpc;

    public async Task<ErrorOr<Success>> Handle(UpsertCronJobCommand request, CancellationToken ct)
    {
        try
        {
            if (request.JobId is not null)
                await _rpc.CronUpdateAsync(request.JobId, request.Payload, ct);
            else
                await _rpc.CronAddAsync(request.Payload, ct);

            return Result.Success;
        }
        catch (Exception ex)
        {
            return Error.Failure("cron.upsert.failed", ex.Message);
        }
    }
}
