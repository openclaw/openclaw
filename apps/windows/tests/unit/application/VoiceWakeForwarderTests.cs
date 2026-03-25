using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.VoiceWake;

namespace OpenClawWindows.Tests.Unit.Application;

public sealed class VoiceWakeForwarderTests
{
    private static VoiceWakeForwarder Make(IGatewayRpcChannel? rpc = null)
    {
        rpc ??= Substitute.For<IGatewayRpcChannel>();
        return new VoiceWakeForwarder(rpc, NullLogger<VoiceWakeForwarder>.Instance);
    }

    // --- PrefixedTranscript ---
    // Mirrors: VoiceWakeForwarderTests.swift — "prefixed transcript uses machine name"

    [Fact]
    public void PrefixedTranscript_UsesMachineName()
    {
        var result = VoiceWakeForwarder.PrefixedTranscript("hello world", "My-Mac");

        Assert.StartsWith("User talked via voice recognition on", result);
        Assert.Contains("My-Mac", result);
        Assert.EndsWith("\n\nhello world", result);
    }

    [Fact]
    public void PrefixedTranscript_FallsBackToEnvironment_WhenMachineNameNull()
    {
        var result = VoiceWakeForwarder.PrefixedTranscript("hi", null);

        Assert.StartsWith("User talked via voice recognition on", result);
        Assert.EndsWith("\n\nhi", result);
    }

    [Fact]
    public void PrefixedTranscript_FallsBackToEnvironment_WhenMachineNameWhitespace()
    {
        // Mirrors Swift: trimmed.isEmpty ? nil : trimmed → falls through to Host.current().localizedName
        var result = VoiceWakeForwarder.PrefixedTranscript("hi", "   ");

        Assert.StartsWith("User talked via voice recognition on", result);
        Assert.EndsWith("\n\nhi", result);
    }

    // --- ForwardOptions defaults ---
    // Mirrors: VoiceWakeForwarderTests.swift — "forward options defaults"

    [Fact]
    public void ForwardOptions_Defaults()
    {
        var opts = new ForwardOptions();

        Assert.Equal("main", opts.SessionKey);
        Assert.Equal("low", opts.Thinking);
        Assert.True(opts.Deliver);
        Assert.Null(opts.To);
        Assert.Equal("webchat", opts.Channel);
    }

    [Fact]
    public async Task ForwardAsync_WebchatChannel_PassesFalseDeliver()
    {
        // Mirrors: #expect(opts.channel.shouldDeliver(opts.deliver) == false)
        // webchat.isDeliverable == false → deliver=false even when ForwardOptions.Deliver=true
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.SendAgentAsync(Arg.Any<GatewayAgentInvocation>(), Arg.Any<CancellationToken>())
           .Returns((true, (string?)null));

        await Make(rpc).ForwardAsync("test", new ForwardOptions { Channel = "webchat", Deliver = true });

        await rpc.Received(1).SendAgentAsync(
            Arg.Is<GatewayAgentInvocation>(i => i.Deliver == false),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ForwardAsync_NonWebchatChannel_PassesThroughDeliver()
    {
        // Non-webchat with Deliver=true → isDeliverable=true → deliver=true passed through
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.SendAgentAsync(Arg.Any<GatewayAgentInvocation>(), Arg.Any<CancellationToken>())
           .Returns((true, (string?)null));

        await Make(rpc).ForwardAsync("test", new ForwardOptions { Channel = "last", Deliver = true });

        await rpc.Received(1).SendAgentAsync(
            Arg.Is<GatewayAgentInvocation>(i => i.Deliver == true),
            Arg.Any<CancellationToken>());
    }

    // --- ForwardAsync ---

    [Fact]
    public async Task ForwardAsync_Ok_ReturnsSuccess()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.SendAgentAsync(Arg.Any<GatewayAgentInvocation>(), Arg.Any<CancellationToken>())
           .Returns((true, (string?)null));

        var (ok, error) = await Make(rpc).ForwardAsync("test");

        Assert.True(ok);
        Assert.Null(error);
    }

    [Fact]
    public async Task ForwardAsync_Failed_ReturnsError()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.SendAgentAsync(Arg.Any<GatewayAgentInvocation>(), Arg.Any<CancellationToken>())
           .Returns((false, "rpc timeout"));

        var (ok, error) = await Make(rpc).ForwardAsync("test");

        Assert.False(ok);
        Assert.Equal("rpc timeout", error);
    }

    [Fact]
    public async Task ForwardAsync_Failed_FallsBackToDefaultMessage_WhenErrorNull()
    {
        // Mirrors Swift: result.error ?? "agent rpc unavailable"
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.SendAgentAsync(Arg.Any<GatewayAgentInvocation>(), Arg.Any<CancellationToken>())
           .Returns((false, (string?)null));

        var (ok, error) = await Make(rpc).ForwardAsync("test");

        Assert.False(ok);
        Assert.Equal("agent rpc unavailable", error);
    }

    [Fact]
    public async Task ForwardAsync_SendsOptions_ToRpc()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.SendAgentAsync(Arg.Any<GatewayAgentInvocation>(), Arg.Any<CancellationToken>())
           .Returns((true, (string?)null));

        var opts = new ForwardOptions { SessionKey = "session-1", Thinking = "high", To = "target" };
        await Make(rpc).ForwardAsync("hello", opts);

        await rpc.Received(1).SendAgentAsync(
            Arg.Is<GatewayAgentInvocation>(i =>
                i.SessionKey == "session-1" &&
                i.Thinking   == "high" &&
                i.To         == "target"),
            Arg.Any<CancellationToken>());
    }

    // --- CheckConnectionAsync ---

    [Fact]
    public async Task CheckConnectionAsync_Ok_ReturnsSuccess()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.StatusAsync(Arg.Any<CancellationToken>())
           .Returns((true, (string?)null));

        var (ok, error) = await Make(rpc).CheckConnectionAsync();

        Assert.True(ok);
        Assert.Null(error);
    }

    [Fact]
    public async Task CheckConnectionAsync_Failed_ReturnsError()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.StatusAsync(Arg.Any<CancellationToken>())
           .Returns((false, "gateway down"));

        var (ok, error) = await Make(rpc).CheckConnectionAsync();

        Assert.False(ok);
        Assert.Equal("gateway down", error);
    }

    [Fact]
    public async Task CheckConnectionAsync_Failed_FallsBackToDefaultMessage_WhenErrorNull()
    {
        // Mirrors Swift: status.error ?? "agent rpc unreachable"
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.StatusAsync(Arg.Any<CancellationToken>())
           .Returns((false, (string?)null));

        var (ok, error) = await Make(rpc).CheckConnectionAsync();

        Assert.False(ok);
        Assert.Equal("agent rpc unreachable", error);
    }
}
