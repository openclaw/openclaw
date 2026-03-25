using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Camera;

namespace OpenClawWindows.Application.Camera;

[UseCase("UC-017")]
public sealed record CameraListQuery : IRequest<ErrorOr<IReadOnlyList<CameraDeviceInfo>>>;

internal sealed class CameraListHandler
    : IRequestHandler<CameraListQuery, ErrorOr<IReadOnlyList<CameraDeviceInfo>>>
{
    private readonly ICameraEnumerator _enumerator;

    public CameraListHandler(ICameraEnumerator enumerator)
    {
        _enumerator = enumerator;
    }

    public async Task<ErrorOr<IReadOnlyList<CameraDeviceInfo>>> Handle(CameraListQuery _, CancellationToken ct)
    {
        var devices = await _enumerator.ListAsync(ct);
        return ErrorOrFactory.From(devices);
    }
}
