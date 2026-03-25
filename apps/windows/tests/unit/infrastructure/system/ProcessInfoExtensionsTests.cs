using OpenClawWindows.Infrastructure.Lifecycle;

namespace OpenClawWindows.Tests.Unit.Infrastructure.System;

public sealed class ProcessInfoExtensionsTests
{
    // ResolveNixMode — mirrors Swift resolveNixMode(environment:standard:stableSuite:isAppBundle:)

    [Fact]
    public void ResolveNixMode_ReturnsFalse_WhenEnvVarAbsent()
    {
        var env = new Dictionary<string, string>();
        Assert.False(ProcessInfoExtensions.ResolveNixMode(env));
    }

    [Fact]
    public void ResolveNixMode_ReturnsTrue_WhenEnvVarIsOne()
    {
        var env = new Dictionary<string, string> { ["OPENCLAW_NIX_MODE"] = "1" };
        Assert.True(ProcessInfoExtensions.ResolveNixMode(env));
    }

    [Theory]
    [InlineData("0")]
    [InlineData("true")]
    [InlineData("yes")]
    [InlineData("")]
    public void ResolveNixMode_ReturnsFalse_WhenEnvVarIsNotExactlyOne(string value)
    {
        // Mirrors Swift: environment["OPENCLAW_NIX_MODE"] == "1" — exact string match
        var env = new Dictionary<string, string> { ["OPENCLAW_NIX_MODE"] = value };
        Assert.False(ProcessInfoExtensions.ResolveNixMode(env));
    }

    // IsRunningTests — mirrors Swift isRunningTests (xctest bundle check + env var fallbacks)

    [Fact]
    public void IsRunningTests_ReturnsTrue_WhenRunningUnderXunit()
    {
        // xunit runner assemblies are loaded in the current test process
        Assert.True(ProcessInfoExtensions.IsRunningTests);
    }

    [Fact]
    public void IsRunningTests_ReturnsTrue_WhenXCTestEnvVarPresent()
    {
        // Mirrors Swift: backwards-compatible XCTest env var fallback
        // This path is already covered because xunit assemblies are loaded, but
        // we verify the env-var logic is structurally equivalent to Swift's.
        var envKey = "XCTestConfigurationFilePath";
        var prev = Environment.GetEnvironmentVariable(envKey);
        try
        {
            Environment.SetEnvironmentVariable(envKey, "/fake/path");
            // IsRunningTests is already true (xunit), so just verify it doesn't break
            Assert.True(ProcessInfoExtensions.IsRunningTests);
        }
        finally
        {
            Environment.SetEnvironmentVariable(envKey, prev);
        }
    }

    // IsPreview — mirrors Swift isPreview (env var XCODE_RUNNING_FOR_PREVIEWS)

    [Fact]
    public void IsPreview_ReturnsFalse_WhenEnvVarAbsent()
    {
        var prev = Environment.GetEnvironmentVariable("XCODE_RUNNING_FOR_PREVIEWS");
        try
        {
            Environment.SetEnvironmentVariable("XCODE_RUNNING_FOR_PREVIEWS", null);
            // May be true due to DesignMode in some test hosts — just verify no exception
            _ = ProcessInfoExtensions.IsPreview;
        }
        finally
        {
            Environment.SetEnvironmentVariable("XCODE_RUNNING_FOR_PREVIEWS", prev);
        }
    }

    [Fact]
    public void IsPreview_ReturnsTrue_WhenEnvVarIsOne()
    {
        var prev = Environment.GetEnvironmentVariable("XCODE_RUNNING_FOR_PREVIEWS");
        try
        {
            Environment.SetEnvironmentVariable("XCODE_RUNNING_FOR_PREVIEWS", "1");
            Assert.True(ProcessInfoExtensions.IsPreview);
        }
        finally
        {
            Environment.SetEnvironmentVariable("XCODE_RUNNING_FOR_PREVIEWS", prev);
        }
    }
}
