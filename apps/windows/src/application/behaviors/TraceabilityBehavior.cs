using System.Reflection;

namespace OpenClawWindows.Application.Behaviors;

// MediatR pipeline behavior that injects UC-ID into log scope for every request.
// Allows Serilog to correlate logs across the full command/query lifecycle.
internal sealed class TraceabilityBehavior<TRequest, TResponse>
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    private readonly ILogger<TraceabilityBehavior<TRequest, TResponse>> _logger;

    public TraceabilityBehavior(ILogger<TraceabilityBehavior<TRequest, TResponse>> logger)
    {
        _logger = logger;
    }

    public async Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        var useCaseId = request.GetType().GetCustomAttribute<UseCaseAttribute>()?.Id ?? "unknown";

        using var _ = _logger.BeginScope(new Dictionary<string, object> { ["UseCaseId"] = useCaseId });

        _logger.LogInformation("UseCase {UseCaseId} started", useCaseId);
        var result = await next();
        _logger.LogInformation("UseCase {UseCaseId} completed", useCaseId);

        return result;
    }
}

[AttributeUsage(AttributeTargets.Class)]
public sealed class UseCaseAttribute : Attribute
{
    public string Id { get; }
    public UseCaseAttribute(string id) => Id = id;
}
