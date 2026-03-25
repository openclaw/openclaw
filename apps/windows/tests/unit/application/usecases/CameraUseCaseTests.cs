using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Camera;

namespace OpenClawWindows.Tests.Unit.Application.UseCases;

public sealed class CameraSnapHandlerTests
{
    private readonly ICameraCapture _camera = Substitute.For<ICameraCapture>();
    private readonly IAuditLogger _audit = Substitute.For<IAuditLogger>();
    private readonly CameraSnapHandler _handler;

    public CameraSnapHandlerTests()
    {
        _handler = new CameraSnapHandler(
            _camera, _audit,
            NullLogger<CameraSnapHandler>.Instance);
    }

    [Fact]
    public async Task Handle_DelegatesToCameraCapture()
    {
        var expected = JpegSnapshot.Create("/9j/base64==", 640, 480).Value;
        _camera.SnapAsync("dev-0", null, Arg.Any<CancellationToken>())
            .Returns(expected);

        var result = await _handler.Handle(new CameraSnapCommand("dev-0", null), default);

        result.IsError.Should().BeFalse();
        result.Value.Should().Be(expected);
    }

    [Fact]
    public async Task Handle_CameraError_PropagatesError()
    {
        _camera.SnapAsync(Arg.Any<string>(), Arg.Any<int?>(), Arg.Any<CancellationToken>())
            .Returns(Error.Failure("CAMERA", "PERMISSION_MISSING: camera"));

        var result = await _handler.Handle(new CameraSnapCommand("dev-0", null), default);

        result.IsError.Should().BeTrue();
    }

    [Fact]
    public async Task Handle_AuditsResult()
    {
        _camera.SnapAsync(Arg.Any<string>(), Arg.Any<int?>(), Arg.Any<CancellationToken>())
            .Returns(JpegSnapshot.Create("/9j/base64==", 1, 1).Value);

        await _handler.Handle(new CameraSnapCommand("dev-0", null), default);

        await _audit.Received(1).LogAsync("camera.snap", "dev-0", true, null, Arg.Any<CancellationToken>());
    }
}

public sealed class CameraListHandlerTests
{
    private readonly ICameraEnumerator _enumerator = Substitute.For<ICameraEnumerator>();
    private readonly CameraListHandler _handler;

    public CameraListHandlerTests()
    {
        _handler = new CameraListHandler(_enumerator);
    }

    [Fact]
    public async Task Handle_ReturnsCameraList()
    {
        var devices = new List<CameraDeviceInfo>
        {
            CameraDeviceInfo.Create("id-0", "Integrated Camera", "front", "builtInWideAngleCamera")
        };
        _enumerator.ListAsync(Arg.Any<CancellationToken>()).Returns(devices);

        var result = await _handler.Handle(new CameraListQuery(), default);

        result.IsError.Should().BeFalse();
        result.Value.Should().HaveCount(1);
        result.Value[0].Name.Should().Be("Integrated Camera");
    }

    [Fact]
    public async Task Handle_EmptyList_ReturnsEmptyResult()
    {
        _enumerator.ListAsync(Arg.Any<CancellationToken>())
            .Returns(Array.Empty<CameraDeviceInfo>());

        var result = await _handler.Handle(new CameraListQuery(), default);

        result.IsError.Should().BeFalse();
        result.Value.Should().BeEmpty();
    }
}
