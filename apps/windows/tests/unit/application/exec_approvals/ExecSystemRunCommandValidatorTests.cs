using System.Text.Json;
using OpenClawWindows.Application.ExecApprovals;

namespace OpenClawWindows.Tests.Unit.Application.ExecApprovals;

// Mirrors ExecSystemRunCommandValidatorTests.swift — uses the shared cross-platform
// system-run command contract fixture so both macOS and Windows verify the same cases.
public sealed class ExecSystemRunCommandValidatorTests
{
    [Theory]
    [MemberData(nameof(ContractCases))]
    public void MatchesSharedSystemRunCommandContractFixture(
        string   name,
        string[] command,
        string?  rawCommand,
        bool     expectedValid,
        string?  expectedDisplay,
        string?  expectedErrorContains)
    {
        var result = ExecSystemRunCommandValidator.Resolve(command, rawCommand);

        if (!expectedValid)
        {
            var invalid = Assert.IsType<ExecSystemRunCommandValidator.ValidationResult.Invalid>(result);
            if (expectedErrorContains is not null)
                Assert.Contains(expectedErrorContains, invalid.Message);
            return;
        }

        var ok = Assert.IsType<ExecSystemRunCommandValidator.ValidationResult.Ok>(result);
        Assert.Equal(expectedDisplay, ok.Resolved.DisplayCommand);
        _ = name; // consumed via test runner display name
    }

    public static IEnumerable<object?[]> ContractCases()
    {
        var fixturePath = FindContractFixturePath();
        using var json  = JsonDocument.Parse(File.ReadAllText(fixturePath));

        foreach (var el in json.RootElement.GetProperty("cases").EnumerateArray())
        {
            var name       = el.GetProperty("name").GetString()!;
            var command    = el.GetProperty("command").EnumerateArray()
                               .Select(e => e.GetString()!).ToArray();
            var rawCommand = el.TryGetProperty("rawCommand", out var rc) ? rc.GetString() : null;
            var expected   = el.GetProperty("expected");
            var valid      = expected.GetProperty("valid").GetBoolean();
            var display    = expected.TryGetProperty("displayCommand", out var dc) ? dc.GetString() : null;
            var errContains = expected.TryGetProperty("errorContains", out var ec) ? ec.GetString() : null;

            yield return [name, command, rawCommand, valid, display, errContains];
        }
    }

    // Mirrors macOS findContractFixtureURL: walk up directories until test/fixtures/... is found.
    private static string FindContractFixturePath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 10 && dir is not null; i++)
        {
            var candidate = Path.Combine(
                dir.FullName, "test", "fixtures", "system-run-command-contract.json");
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new FileNotFoundException(
            "system-run-command-contract.json contract fixture not found " +
            $"(searched from {AppContext.BaseDirectory})");
    }
}
