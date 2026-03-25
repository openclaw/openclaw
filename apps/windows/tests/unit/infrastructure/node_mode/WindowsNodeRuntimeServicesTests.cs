using ErrorOr;
using NSubstitute;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Camera;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Permissions;
using OpenClawWindows.Infrastructure.NodeMode;
using Microsoft.Extensions.Logging.Abstractions;

namespace OpenClawWindows.Tests.Unit.Infrastructure.NodeMode;

public sealed class WindowsNodeRuntimeServicesTests
{
    private readonly IScreenCapture    _screenCapture = Substitute.For<IScreenCapture>();
    private readonly IGeolocator       _geolocator    = Substitute.For<IGeolocator>();
    private readonly IPermissionManager _permissions  = Substitute.For<IPermissionManager>();
    private readonly WindowsNodeRuntimeServices _sut;

    public WindowsNodeRuntimeServicesTests()
    {
        _sut = new WindowsNodeRuntimeServices(
            _screenCapture,
            _geolocator,
            _permissions,
            NullLogger<WindowsNodeRuntimeServices>.Instance);
    }

    // ── RecordScreenAsync ─────────────────────────────────────────────────────
    // Mirrors Swift: func recordScreen(screenIndex:durationMs:fps:includeAudio:outPath:)

    [Fact]
    public async Task RecordScreenAsync_DelegatesToScreenCapture()
    {
        var p      = ScreenRecordingParams.FromJson("""{"durationMs":5000,"fps":30,"screenIndex":0}""").Value;
        var result = ScreenRecordingResult.Create("base64data==", 5000, 30f, 0, false);
        _screenCapture.RecordAsync(p, Arg.Any<CancellationToken>())
                      .Returns(result);

        var actual = await _sut.RecordScreenAsync(p, CancellationToken.None);

        await _screenCapture.Received(1).RecordAsync(p, Arg.Any<CancellationToken>());
        Assert.Equal(result, actual);
    }

    // ── IsLocationGrantedAsync ────────────────────────────────────────────────
    // Mirrors Swift: func locationAuthorizationStatus() -> CLAuthorizationStatus

    [Fact]
    public async Task IsLocationGrantedAsync_ReturnsTrue_WhenLocationGranted()
    {
        _permissions.StatusAsync(Arg.Any<IEnumerable<Capability>>(), Arg.Any<CancellationToken>())
                    .Returns(new Dictionary<Capability, bool> { [Capability.Location] = true });

        var result = await _sut.IsLocationGrantedAsync(CancellationToken.None);

        Assert.True(result);
    }

    [Fact]
    public async Task IsLocationGrantedAsync_ReturnsFalse_WhenLocationDenied()
    {
        _permissions.StatusAsync(Arg.Any<IEnumerable<Capability>>(), Arg.Any<CancellationToken>())
                    .Returns(new Dictionary<Capability, bool> { [Capability.Location] = false });

        var result = await _sut.IsLocationGrantedAsync(CancellationToken.None);

        Assert.False(result);
    }

    [Fact]
    public async Task IsLocationGrantedAsync_ReturnsFalse_WhenLocationKeyAbsent()
    {
        // Guard: TryGetValue returns false when key not present
        _permissions.StatusAsync(Arg.Any<IEnumerable<Capability>>(), Arg.Any<CancellationToken>())
                    .Returns(new Dictionary<Capability, bool>());

        var result = await _sut.IsLocationGrantedAsync(CancellationToken.None);

        Assert.False(result);
    }

    // ── IsLocationFullAccuracy ────────────────────────────────────────────────
    // Mirrors Swift: func locationAccuracyAuthorization() -> CLAccuracyAuthorization
    // Adapts: Windows has no reduced-accuracy concept — always reports full accuracy.

    [Fact]
    public void IsLocationFullAccuracy_AlwaysReturnsTrue()
    {
        Assert.True(_sut.IsLocationFullAccuracy());
    }

    // ── GetCurrentLocationAsync ───────────────────────────────────────────────
    // Mirrors Swift: func currentLocation(desiredAccuracy:maxAgeMs:timeoutMs:)

    [Fact]
    public async Task GetCurrentLocationAsync_DelegatesToGeolocator()
    {
        var reading = LocationReading.Create(40.7128, -74.0060, 5.0, null, null, null, 1_700_000_000_000L);
        ErrorOr<LocationReading> expected = reading;
        _geolocator.GetCurrentLocationAsync("best", 5000, 10000, Arg.Any<CancellationToken>())
                   .Returns(expected);

        var result = await _sut.GetCurrentLocationAsync("best", 5000, 10000, CancellationToken.None);

        await _geolocator.Received(1).GetCurrentLocationAsync(
            "best", 5000, 10000, Arg.Any<CancellationToken>());
        Assert.Equal(expected, result);
    }

    [Fact]
    public async Task GetCurrentLocationAsync_PassesNullsThrough()
    {
        var reading = LocationReading.Create(51.5074, -0.1278, 10.0, null, null, null, 1_700_000_000_000L);
        ErrorOr<LocationReading> expected = reading;
        _geolocator.GetCurrentLocationAsync(null, null, null, Arg.Any<CancellationToken>())
                   .Returns(expected);

        var result = await _sut.GetCurrentLocationAsync(null, null, null, CancellationToken.None);

        await _geolocator.Received(1).GetCurrentLocationAsync(
            null, null, null, Arg.Any<CancellationToken>());
        Assert.Equal(expected, result);
    }
}
