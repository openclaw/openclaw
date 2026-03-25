namespace OpenClawWindows.Tests.Unit.Domain.Camera;

public sealed class CameraSessionTests
{
    [Fact]
    public void Create_InitialState_IsIdle()
    {
        var session = CameraSession.Create("cam-0");

        session.State.Should().Be(CameraSessionState.Idle);
        session.Id.Should().Be("cam-0");
    }

    [Fact]
    public void Create_EmptyDeviceId_Throws()
    {
        var act = () => CameraSession.Create("");
        act.Should().Throw<Exception>();
    }

    // ── BeginPhotoCapture ───────────────────────────────────────────────────

    [Fact]
    public void BeginPhotoCapture_FromIdle_TransitionsToCapturingPhoto()
    {
        var session = CameraSession.Create("cam-0");

        session.BeginPhotoCapture();

        session.State.Should().Be(CameraSessionState.CapturingPhoto);
    }

    [Fact]
    public void BeginPhotoCapture_WhenBusy_Throws()
    {
        var session = CameraSession.Create("cam-0");
        session.BeginPhotoCapture();

        var act = () => session.BeginPhotoCapture();

        act.Should().Throw<InvalidOperationException>().WithMessage("*busy*");
    }

    // ── BeginClipCapture ────────────────────────────────────────────────────

    [Theory]
    [InlineData(250)]   // min
    [InlineData(3000)]  // default
    [InlineData(60000)] // max
    public void BeginClipCapture_ValidDuration_Succeeds(int durationMs)
    {
        var session = CameraSession.Create("cam-0");

        session.BeginClipCapture(durationMs);

        session.State.Should().Be(CameraSessionState.CapturingClip);
    }

    [Theory]
    [InlineData(249)]   // below min
    [InlineData(60001)] // above max
    public void BeginClipCapture_OutOfRangeDuration_Throws(int durationMs)
    {
        var session = CameraSession.Create("cam-0");

        var act = () => session.BeginClipCapture(durationMs);

        act.Should().Throw<Exception>();
    }

    [Fact]
    public void BeginClipCapture_WhenBusy_Throws()
    {
        var session = CameraSession.Create("cam-0");
        session.BeginClipCapture(1000);

        var act = () => session.BeginClipCapture(1000);

        act.Should().Throw<InvalidOperationException>();
    }

    // ── EndCapture ──────────────────────────────────────────────────────────

    [Fact]
    public void EndCapture_ResetsToIdle()
    {
        var session = CameraSession.Create("cam-0");
        session.BeginPhotoCapture();

        session.EndCapture();

        session.State.Should().Be(CameraSessionState.Idle);
    }
}
