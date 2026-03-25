using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Skills;
using OpenClawWindows.Domain.Skills;

namespace OpenClawWindows.Tests.Integration.Skills;

// Integration: ListSkillsHandler + SetSkillEnabledHandler + InstallSkillHandler.
// Tests the full handler chain against a mocked IGatewayRpcChannel.
public sealed class SkillsLifecycleTests
{
    private readonly IGatewayRpcChannel _rpc = Substitute.For<IGatewayRpcChannel>();

    // ── ListSkillsHandler ─────────────────────────────────────────────────────

    [Fact]
    public async Task ListSkills_ValidResponse_ReturnsSortedByName()
    {
        var json = $$"""
            {
              "workspaceDir": "/workspace",
              "managedSkillsDir": "/managed",
              "skills": [
                {{SkillJson("zebra",  "sk-z", "local")}},
                {{SkillJson("alpha",  "sk-a", "managed")}},
                {{SkillJson("middle", "sk-m", "local")}}
              ]
            }
            """;
        _rpc.SkillsStatusAsync(Arg.Any<CancellationToken>())
            .Returns(JsonDocument.Parse(json).RootElement.Clone());

        var handler = new ListSkillsHandler(_rpc);
        var result = await handler.Handle(new ListSkillsQuery(), default);

        result.IsError.Should().BeFalse();
        result.Value.Should().HaveCount(3);
        result.Value[0].Name.Should().Be("alpha");
        result.Value[1].Name.Should().Be("middle");
        result.Value[2].Name.Should().Be("zebra");
    }

    // Produces a minimal but valid SkillStatus JSON object for deserialization
    private static string SkillJson(string name, string key, string source) =>
        $$"""{"name":"{{name}}","skillKey":"{{key}}","source":"{{source}}","description":"","filePath":"/p","baseDir":"/b","always":false,"disabled":false,"eligible":true,"requirements":{"bins":[],"env":[],"config":[]},"missing":{"bins":[],"env":[],"config":[]},"configChecks":[],"install":[]}""";

    [Fact]
    public async Task ListSkills_EmptySkillsArray_ReturnsEmptyList()
    {
        var json = """{"workspaceDir":"/w","managedSkillsDir":"/m","skills":[]}""";
        _rpc.SkillsStatusAsync(Arg.Any<CancellationToken>())
            .Returns(JsonDocument.Parse(json).RootElement.Clone());

        var handler = new ListSkillsHandler(_rpc);
        var result = await handler.Handle(new ListSkillsQuery(), default);

        result.IsError.Should().BeFalse();
        result.Value.Should().BeEmpty();
    }

    [Fact]
    public async Task ListSkills_RpcThrows_ReturnsFailure()
    {
        _rpc.SkillsStatusAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromException<JsonElement>(new Exception("connection lost")));

        var handler = new ListSkillsHandler(_rpc);
        var result = await handler.Handle(new ListSkillsQuery(), default);

        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("skills.status.failed");
    }

    [Fact]
    public async Task ListSkills_NullDeserialize_ReturnsUnexpectedError()
    {
        // Returning an empty JSON object causes Deserialize to return a non-null
        // SkillsStatusReport with null Skills — guard against empty payload
        var json = """null""";
        _rpc.SkillsStatusAsync(Arg.Any<CancellationToken>())
            .Returns(JsonDocument.Parse(json).RootElement.Clone());

        var handler = new ListSkillsHandler(_rpc);
        var result = await handler.Handle(new ListSkillsQuery(), default);

        result.IsError.Should().BeTrue();
    }

    // ── SetSkillEnabledHandler ────────────────────────────────────────────────

    [Fact]
    public async Task SetSkillEnabled_True_CallsRpcWithEnabled()
    {
        _rpc.SkillsUpdateAsync(Arg.Any<string>(), Arg.Any<bool?>(),
                Arg.Any<string?>(), Arg.Any<Dictionary<string, string>?>(),
                Arg.Any<CancellationToken>())
            .Returns(JsonDocument.Parse("{}").RootElement.Clone());

        var handler = new SetSkillEnabledHandler(_rpc);
        var result = await handler.Handle(
            new SetSkillEnabledCommand("sk-alpha", true), default);

        result.IsError.Should().BeFalse();
        await _rpc.Received(1).SkillsUpdateAsync(
            "sk-alpha", true, Arg.Any<string?>(),
            Arg.Any<Dictionary<string, string>?>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SetSkillEnabled_False_CallsRpcWithDisabled()
    {
        _rpc.SkillsUpdateAsync(Arg.Any<string>(), Arg.Any<bool?>(),
                Arg.Any<string?>(), Arg.Any<Dictionary<string, string>?>(),
                Arg.Any<CancellationToken>())
            .Returns(JsonDocument.Parse("{}").RootElement.Clone());

        var handler = new SetSkillEnabledHandler(_rpc);
        var result = await handler.Handle(
            new SetSkillEnabledCommand("sk-zebra", false), default);

        result.IsError.Should().BeFalse();
        await _rpc.Received(1).SkillsUpdateAsync(
            "sk-zebra", false, Arg.Any<string?>(),
            Arg.Any<Dictionary<string, string>?>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SetSkillEnabled_RpcThrows_ReturnsFailure()
    {
        _rpc.SkillsUpdateAsync(Arg.Any<string>(), Arg.Any<bool?>(),
                Arg.Any<string?>(), Arg.Any<Dictionary<string, string>?>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromException<JsonElement>(new Exception("timeout")));

        var handler = new SetSkillEnabledHandler(_rpc);
        var result = await handler.Handle(
            new SetSkillEnabledCommand("sk-x", true), default);

        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("skills.update.failed");
    }

    // ── InstallSkillHandler ───────────────────────────────────────────────────

    [Fact]
    public async Task InstallSkill_Success_ReturnsInstallResult()
    {
        var json = """{"ok":true,"message":"installed","stdout":"","stderr":"","code":0}""";
        _rpc.SkillsInstallAsync(Arg.Any<string>(), Arg.Any<string>(),
                Arg.Any<int?>(), Arg.Any<CancellationToken>())
            .Returns(JsonDocument.Parse(json).RootElement.Clone());

        var handler = new InstallSkillHandler(_rpc);
        var result = await handler.Handle(
            new InstallSkillCommand("my-skill", "npm"), default);

        result.IsError.Should().BeFalse();
        result.Value.Ok.Should().BeTrue();
        result.Value.Message.Should().Be("installed");
    }

    [Fact]
    public async Task InstallSkill_GatewayReturnsFailure_ReturnsResult()
    {
        var json = """{"ok":false,"message":"install failed","stdout":"","stderr":"err","code":1}""";
        _rpc.SkillsInstallAsync(Arg.Any<string>(), Arg.Any<string>(),
                Arg.Any<int?>(), Arg.Any<CancellationToken>())
            .Returns(JsonDocument.Parse(json).RootElement.Clone());

        var handler = new InstallSkillHandler(_rpc);
        var result = await handler.Handle(
            new InstallSkillCommand("bad-skill", "npm"), default);

        result.IsError.Should().BeFalse();
        result.Value.Ok.Should().BeFalse();
        result.Value.Code.Should().Be(1);
    }

    [Fact]
    public async Task InstallSkill_RpcThrows_ReturnsFailureError()
    {
        _rpc.SkillsInstallAsync(Arg.Any<string>(), Arg.Any<string>(),
                Arg.Any<int?>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<JsonElement>(new Exception("timeout")));

        var handler = new InstallSkillHandler(_rpc);
        var result = await handler.Handle(
            new InstallSkillCommand("my-skill", "npm"), default);

        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("skills.install.failed");
    }
}
