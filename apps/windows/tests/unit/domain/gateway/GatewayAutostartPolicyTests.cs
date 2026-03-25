using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Tests.Unit.Domain.Gateway;

public sealed class GatewayAutostartPolicyTests
{
    // Mirrors startsGatewayOnlyWhenLocalAndNotPaused in Swift.

    [Fact]
    public void ShouldStartGateway_LocalNotPaused_ReturnsTrue() =>
        GatewayAutostartPolicy.ShouldStartGateway(ConnectionMode.Local, paused: false).Should().BeTrue();

    [Fact]
    public void ShouldStartGateway_LocalPaused_ReturnsFalse() =>
        GatewayAutostartPolicy.ShouldStartGateway(ConnectionMode.Local, paused: true).Should().BeFalse();

    [Fact]
    public void ShouldStartGateway_RemoteNotPaused_ReturnsFalse() =>
        GatewayAutostartPolicy.ShouldStartGateway(ConnectionMode.Remote, paused: false).Should().BeFalse();

    [Fact]
    public void ShouldStartGateway_UnconfiguredNotPaused_ReturnsFalse() =>
        GatewayAutostartPolicy.ShouldStartGateway(ConnectionMode.Unconfigured, paused: false).Should().BeFalse();

    // Mirrors ensuresLaunchAgentWhenLocalAndNotAttachOnly in Swift.

    [Fact]
    public void ShouldEnsureAutostart_LocalNotPaused_ReturnsTrue() =>
        GatewayAutostartPolicy.ShouldEnsureAutostart(ConnectionMode.Local, paused: false).Should().BeTrue();

    [Fact]
    public void ShouldEnsureAutostart_LocalPaused_ReturnsFalse() =>
        GatewayAutostartPolicy.ShouldEnsureAutostart(ConnectionMode.Local, paused: true).Should().BeFalse();

    [Fact]
    public void ShouldEnsureAutostart_RemoteNotPaused_ReturnsFalse() =>
        GatewayAutostartPolicy.ShouldEnsureAutostart(ConnectionMode.Remote, paused: false).Should().BeFalse();

    // ShouldEnsureAutostart must always agree with ShouldStartGateway (mirrors Swift delegation).

    [Theory]
    [InlineData(ConnectionMode.Local,        false)]
    [InlineData(ConnectionMode.Local,        true)]
    [InlineData(ConnectionMode.Remote,       false)]
    [InlineData(ConnectionMode.Remote,       true)]
    [InlineData(ConnectionMode.Unconfigured, false)]
    [InlineData(ConnectionMode.Unconfigured, true)]
    public void ShouldEnsureAutostart_AlwaysMatchesShouldStartGateway(ConnectionMode mode, bool paused) =>
        GatewayAutostartPolicy.ShouldEnsureAutostart(mode, paused)
            .Should().Be(GatewayAutostartPolicy.ShouldStartGateway(mode, paused));
}
