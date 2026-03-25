using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.Skills;

public sealed record SkillsStatusReport(
    [property: JsonPropertyName("workspaceDir")]    string WorkspaceDir,
    [property: JsonPropertyName("managedSkillsDir")] string ManagedSkillsDir,
    [property: JsonPropertyName("skills")]          IReadOnlyList<SkillStatus> Skills);

public sealed record SkillStatus(
    [property: JsonPropertyName("name")]         string Name,
    [property: JsonPropertyName("description")]  string Description,
    [property: JsonPropertyName("source")]       string Source,
    [property: JsonPropertyName("filePath")]     string FilePath,
    [property: JsonPropertyName("baseDir")]      string BaseDir,
    [property: JsonPropertyName("skillKey")]     string SkillKey,
    [property: JsonPropertyName("primaryEnv")]   string? PrimaryEnv,
    [property: JsonPropertyName("emoji")]        string? Emoji,
    [property: JsonPropertyName("homepage")]     string? Homepage,
    [property: JsonPropertyName("always")]       bool Always,
    [property: JsonPropertyName("disabled")]     bool Disabled,
    [property: JsonPropertyName("eligible")]     bool Eligible,
    [property: JsonPropertyName("requirements")] SkillRequirements Requirements,
    [property: JsonPropertyName("missing")]      SkillMissing Missing,
    [property: JsonPropertyName("configChecks")] IReadOnlyList<SkillStatusConfigCheck> ConfigChecks,
    [property: JsonPropertyName("install")]      IReadOnlyList<SkillInstallOption> Install)
{
    // primary key for de-duplication
    public string Id => Name;
}

public sealed record SkillRequirements(
    [property: JsonPropertyName("bins")]   IReadOnlyList<string> Bins,
    [property: JsonPropertyName("env")]    IReadOnlyList<string> Env,
    [property: JsonPropertyName("config")] IReadOnlyList<string> Config);

public sealed record SkillMissing(
    [property: JsonPropertyName("bins")]   IReadOnlyList<string> Bins,
    [property: JsonPropertyName("env")]    IReadOnlyList<string> Env,
    [property: JsonPropertyName("config")] IReadOnlyList<string> Config);

public sealed record SkillStatusConfigCheck(
    [property: JsonPropertyName("path")]      string Path,
    [property: JsonPropertyName("value")]     JsonElement? Value,
    [property: JsonPropertyName("satisfied")] bool Satisfied);

public sealed record SkillInstallOption(
    [property: JsonPropertyName("id")]    string Id,
    [property: JsonPropertyName("kind")]  string Kind,
    [property: JsonPropertyName("label")] string Label,
    [property: JsonPropertyName("bins")]  IReadOnlyList<string> Bins);

public sealed record SkillInstallResult(
    [property: JsonPropertyName("ok")]      bool Ok,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("stdout")]  string? Stdout,
    [property: JsonPropertyName("stderr")]  string? Stderr,
    [property: JsonPropertyName("code")]    int? Code);

public sealed record SkillUpdateResult(
    [property: JsonPropertyName("ok")]       bool Ok,
    [property: JsonPropertyName("skillKey")] string SkillKey);
