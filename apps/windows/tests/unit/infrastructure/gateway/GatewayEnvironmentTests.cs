using OpenClawWindows.Infrastructure.Gateway;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Gateway;

public sealed class GatewayEnvironmentTests
{
    // ── Semver.Parse ──────────────────────────────────────────────────────────
    // Mirrors macOS: GatewayEnvironmentTests.semverParsesCommonForms

    [Fact]
    public void SemverParse_CommonForms()
    {
        Assert.Equal(new Semver(1, 2, 3),       Semver.Parse("1.2.3"));
        Assert.Equal(new Semver(1, 2, 3),       Semver.Parse("  v1.2.3  \n"));  // trim + v prefix
        Assert.Equal(new Semver(2, 0, 0),       Semver.Parse("v2.0.0"));
        Assert.Equal(new Semver(3, 4, 5),       Semver.Parse("3.4.5-beta.1"));  // prerelease stripped
        Assert.Equal(new Semver(2026, 1, 11),   Semver.Parse("2026.1.11-4"));   // build suffix stripped
        Assert.Equal(new Semver(1, 0, 5),       Semver.Parse("1.0.5+build.123")); // metadata stripped
        Assert.Equal(new Semver(1, 2, 3),       Semver.Parse("v1.2.3+build.9"));
        Assert.Equal(new Semver(1, 2, 3),       Semver.Parse("1.2.3+build.123"));
        Assert.Equal(new Semver(1, 2, 3),       Semver.Parse("1.2.3-rc.1+build.7"));
        Assert.Equal(new Semver(1, 2, 3),       Semver.Parse("v1.2.3-rc.1"));
        Assert.Equal(new Semver(1, 2, 0),       Semver.Parse("1.2.0"));
    }

    [Fact]
    public void SemverParse_InvalidInputs_ReturnNull()
    {
        Assert.Null(Semver.Parse(null));
        Assert.Null(Semver.Parse("invalid"));
        Assert.Null(Semver.Parse("1.2"));    // only 2 parts
        Assert.Null(Semver.Parse("1.2.x")); // non-numeric patch
        Assert.Null(Semver.Parse(""));
        Assert.Null(Semver.Parse("   "));
    }

    // ── Semver.Compatible ─────────────────────────────────────────────────────
    // Mirrors macOS: semverCompatibilityRequiresSameMajorAndNotOlder

    [Fact]
    public void SemverCompatibility_SameMajorNotOlder_IsCompatible()
    {
        var required = new Semver(2, 1, 0);
        Assert.True(new Semver(2, 1, 0).Compatible(required));
        Assert.True(new Semver(2, 2, 0).Compatible(required));
        Assert.True(new Semver(2, 1, 1).Compatible(required));
    }

    [Fact]
    public void SemverCompatibility_OlderOrDifferentMajor_IsNotCompatible()
    {
        var required = new Semver(2, 1, 0);
        Assert.False(new Semver(2, 0, 9).Compatible(required)); // older minor
        Assert.False(new Semver(3, 0, 0).Compatible(required)); // different major
        Assert.False(new Semver(1, 9, 9).Compatible(required)); // different major
    }

    // ── Semver ordering ───────────────────────────────────────────────────────

    [Fact]
    public void Semver_Ordering_MajorFirst_ThenMinor_ThenPatch()
    {
        Assert.True(new Semver(1, 0, 0) < new Semver(2, 0, 0));
        Assert.True(new Semver(2, 0, 0) < new Semver(2, 1, 0));
        Assert.True(new Semver(2, 1, 0) < new Semver(2, 1, 1));
        Assert.True(new Semver(2, 1, 1) >= new Semver(2, 1, 1));
    }

    // ── GatewayEnvironment.GatewayPort ───────────────────────────────────────
    // Mirrors macOS: gatewayPortDefaultsAndRespectsOverride

    [Fact]
    public void GatewayPort_NoOverride_Returns18789()
    {
        // Remove env var to ensure default is returned
        var saved = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_PORT");
        try
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_PORT", null);
            // Config file override also absent in test isolation
            Assert.Equal(18789, GatewayEnvironment.GatewayPort());
        }
        finally
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_PORT", saved);
        }
    }

    [Fact]
    public void GatewayPort_EnvVarOverride_ReturnsOverrideValue()
    {
        var saved = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_PORT");
        try
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_PORT", "19999");
            Assert.Equal(19999, GatewayEnvironment.GatewayPort());
        }
        finally
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_PORT", saved);
        }
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("abc")]
    [InlineData("  ")]
    public void GatewayPort_InvalidEnvVar_FallsBackToDefault(string raw)
    {
        var saved = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_PORT");
        try
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_PORT", raw);
            Assert.Equal(18789, GatewayEnvironment.GatewayPort());
        }
        finally
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_PORT", saved);
        }
    }

    // ── GatewayEnvironment.ExpectedGatewayVersion(from:) ─────────────────────
    // Mirrors macOS: expectedGatewayVersionFromStringUsesParser

    [Fact]
    public void ExpectedGatewayVersionFromString_ValidInput_ParsesCorrectly()
    {
        Assert.Equal(new Semver(9, 1, 2), GatewayEnvironment.ExpectedGatewayVersion("v9.1.2"));
        Assert.Equal(new Semver(2026, 1, 11), GatewayEnvironment.ExpectedGatewayVersion("2026.1.11-4"));
    }

    [Fact]
    public void ExpectedGatewayVersionFromString_Null_ReturnsNull()
    {
        Assert.Null(GatewayEnvironment.ExpectedGatewayVersion((string?)null));
    }

    // ── GatewayEnvironmentStatus.Checking ────────────────────────────────────

    [Fact]
    public void GatewayEnvironmentStatusChecking_HasCorrectKindAndMessage()
    {
        var s = GatewayEnvironmentStatus.Checking;
        Assert.IsType<GatewayEnvironmentKind.Checking>(s.Kind);
        Assert.False(string.IsNullOrWhiteSpace(s.Message));
        Assert.Null(s.NodeVersion);
        Assert.Null(s.GatewayVersion);
    }

    // ── PreferredGatewayBind ──────────────────────────────────────────────────

    [Fact]
    public void PreferredGatewayBind_RemoteMode_ReturnsNull()
    {
        // Mirrors Swift: if CommandResolver.connectionModeIsRemote() { return nil }
        var settings = OpenClawWindows.Domain.Settings.AppSettings.WithDefaults(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
        settings.SetConnectionMode(OpenClawWindows.Domain.Settings.ConnectionMode.Remote);
        Assert.Null(GatewayEnvironment.PreferredGatewayBind(settings));
    }

    [Theory]
    [InlineData("loopback")]
    [InlineData("lan")]
    [InlineData("tailnet")]
    [InlineData("auto")]
    public void PreferredGatewayBind_ValidEnvVar_ReturnsBind(string bind)
    {
        var saved = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_BIND");
        try
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_BIND", bind);
            Assert.Equal(bind, GatewayEnvironment.PreferredGatewayBind());
        }
        finally
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_BIND", saved);
        }
    }

    [Theory]
    [InlineData("LOOPBACK")]   // case-insensitive
    [InlineData("  loopback  ")] // whitespace trimmed
    public void PreferredGatewayBind_CaseAndWhitespaceTolerant(string raw)
    {
        var saved = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_BIND");
        try
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_BIND", raw);
            Assert.Equal("loopback", GatewayEnvironment.PreferredGatewayBind());
        }
        finally
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_BIND", saved);
        }
    }

    [Fact]
    public void PreferredGatewayBind_InvalidEnvVar_ReturnsNull()
    {
        var saved = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_BIND");
        try
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_BIND", "unknown-bind");
            // No config override → null
            Assert.Null(GatewayEnvironment.PreferredGatewayBind());
        }
        finally
        {
            Environment.SetEnvironmentVariable("OPENCLAW_GATEWAY_BIND", saved);
        }
    }

    // ── ReadLocalGatewayVersion ───────────────────────────────────────────────

    [Fact]
    public void ReadLocalGatewayVersion_ValidPackageJson_ParsesVersion()
    {
        var dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "package.json"),
                """{"name":"openclaw","version":"3.5.1"}""");

            Assert.Equal(new Semver(3, 5, 1), GatewayEnvironment.ReadLocalGatewayVersion(dir));
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void ReadLocalGatewayVersion_MissingFile_ReturnsNull()
    {
        Assert.Null(GatewayEnvironment.ReadLocalGatewayVersion(
            Path.Combine(Path.GetTempPath(), "__openclaw_no_such_dir__")));
    }

    [Fact]
    public void ReadLocalGatewayVersion_MalformedJson_ReturnsNull()
    {
        var dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "package.json"), "not json");
            Assert.Null(GatewayEnvironment.ReadLocalGatewayVersion(dir));
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void ReadLocalGatewayVersion_NoVersionField_ReturnsNull()
    {
        var dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "package.json"), """{"name":"openclaw"}""");
            Assert.Null(GatewayEnvironment.ReadLocalGatewayVersion(dir));
        }
        finally { Directory.Delete(dir, recursive: true); }
    }
}
