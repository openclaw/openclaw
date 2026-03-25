using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.VoiceWake;

namespace OpenClawWindows.Tests.Unit.Application.UseCases;

public sealed class StartVoiceWakeHandlerTests
{
    private readonly IPorcupineDetector     _porcupine = Substitute.For<IPorcupineDetector>();
    private readonly IAudioCaptureDevice    _audio     = Substitute.For<IAudioCaptureDevice>();
    private readonly IVoicePushToTalkService _ptt      = Substitute.For<IVoicePushToTalkService>();
    private readonly StartVoiceWakeHandler  _handler;

    public StartVoiceWakeHandlerTests()
    {
        _handler = new StartVoiceWakeHandler(
            _porcupine, _audio, _ptt,
            NullLogger<StartVoiceWakeHandler>.Instance);
    }

    [Fact]
    public async Task Handle_PermissionDenied_ReturnsError_AndDoesNotEnablePtt()
    {
        _audio.IsPermissionGrantedAsync(Arg.Any<CancellationToken>()).Returns(false);

        var result = await _handler.Handle(new StartVoiceWakeCommand(), CancellationToken.None);

        Assert.True(result.IsError);
        _ptt.DidNotReceive().SetEnabled(Arg.Any<bool>());
    }

    [Fact]
    public async Task Handle_PermissionGranted_EnablesPushToTalk()
    {
        _audio.IsPermissionGrantedAsync(Arg.Any<CancellationToken>()).Returns(true);
        _porcupine.StartAsync(Arg.Any<CancellationToken>()).Returns(Result.Success);

        await _handler.Handle(new StartVoiceWakeCommand(), CancellationToken.None);

        _ptt.Received(1).SetEnabled(true);
    }

    [Fact]
    public async Task Handle_PermissionGranted_ReturnSuccess()
    {
        _audio.IsPermissionGrantedAsync(Arg.Any<CancellationToken>()).Returns(true);
        _porcupine.StartAsync(Arg.Any<CancellationToken>()).Returns(Result.Success);

        var result = await _handler.Handle(new StartVoiceWakeCommand(), CancellationToken.None);

        Assert.False(result.IsError);
    }

    [Fact]
    public async Task Handle_PorcupineFails_StillEnablesPttAndSucceeds()
    {
        // SPIKE-004: Porcupine always returns error until SDK is integrated.
        // PTT must still activate and the handler must succeed.
        _audio.IsPermissionGrantedAsync(Arg.Any<CancellationToken>()).Returns(true);
        _porcupine.StartAsync(Arg.Any<CancellationToken>())
            .Returns(Error.Failure("SPIKE_004", "Porcupine SDK not yet integrated"));

        var result = await _handler.Handle(new StartVoiceWakeCommand(), CancellationToken.None);

        _ptt.Received(1).SetEnabled(true);
        Assert.False(result.IsError);
    }
}

public sealed class StopVoiceWakeHandlerTests
{
    private readonly IPorcupineDetector      _porcupine = Substitute.For<IPorcupineDetector>();
    private readonly IVoicePushToTalkService _ptt       = Substitute.For<IVoicePushToTalkService>();
    private readonly StopVoiceWakeHandler    _handler;

    public StopVoiceWakeHandlerTests()
    {
        _handler = new StopVoiceWakeHandler(
            _porcupine, _ptt,
            NullLogger<StopVoiceWakeHandler>.Instance);
    }

    [Fact]
    public async Task Handle_DisablesPushToTalk()
    {
        await _handler.Handle(new StopVoiceWakeCommand(), CancellationToken.None);

        _ptt.Received(1).SetEnabled(false);
    }

    [Fact]
    public async Task Handle_StopsPorcupineDetector()
    {
        await _handler.Handle(new StopVoiceWakeCommand(), CancellationToken.None);

        await _porcupine.Received(1).StopAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_ReturnsSuccess()
    {
        var result = await _handler.Handle(new StopVoiceWakeCommand(), CancellationToken.None);

        Assert.False(result.IsError);
    }
}
