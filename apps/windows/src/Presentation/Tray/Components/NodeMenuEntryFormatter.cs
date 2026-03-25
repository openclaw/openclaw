using System.Text.RegularExpressions;
using OpenClawWindows.Domain.Nodes;
using OpenClawWindows.Presentation.Formatters;

namespace OpenClawWindows.Presentation.Tray.Components;

// for node menu rows. Adapts: NSImage symbol lookup → Segoe MDL2 glyph codes.
internal static class NodeMenuEntryFormatter
{
    internal static bool IsGateway(NodeInfo entry) => entry.NodeId == "gateway";

    internal static bool IsConnected(NodeInfo entry) => entry.IsConnected;

    // gateway uses displayName ?? "Gateway"; others use displayName ?? nodeId.
    internal static string PrimaryName(NodeInfo entry) =>
        IsGateway(entry)
            ? NonEmpty(entry.DisplayName) ?? "Gateway"
            : NonEmpty(entry.DisplayName) ?? entry.NodeId;

    internal static string RoleText(NodeInfo entry)
    {
        if (entry.IsConnected) return "connected";
        if (IsGateway(entry))  return "disconnected";
        if (entry.IsPaired)    return "paired";
        return "unpaired";
    }

    // "{ip} · {role}" or just role.
    internal static string DetailLeft(NodeInfo entry)
    {
        var ip = NonEmpty(entry.RemoteIp);
        return ip is not null ? $"{ip} · {RoleText(entry)}" : RoleText(entry);
    }

    internal static string? HeadlineRight(NodeInfo entry) => PlatformText(entry);

    // version labels not compact (uses shortVersionLabel).
    internal static string? DetailRightVersion(NodeInfo entry)
    {
        var labels = VersionLabels(entry, compact: false);
        return labels.Count == 0 ? null : string.Join(" · ", labels);
    }

    // platform string via PlatformLabelFormatter, then deviceFamily heuristics.
    internal static string? PlatformText(NodeInfo entry)
    {
        var raw = NonEmpty(entry.Platform);
        if (raw is not null)
            return PlatformLabelFormatter.Pretty(raw) ?? raw;

        var family = entry.DeviceFamily?.Trim().ToLowerInvariant();
        if (family is null) return null;
        if (family.Contains("mac"))     return "macOS";
        if (family.Contains("iphone"))  return "iOS";
        if (family.Contains("ipad"))    return "iPadOS";
        if (family.Contains("android")) return "Android";
        return null;
    }

    // deviceFamily=="android" or platform contains "android".
    internal static bool IsAndroid(NodeInfo entry)
    {
        var family = entry.DeviceFamily?.Trim().ToLowerInvariant();
        if (family == "android") return true;
        return entry.Platform?.Trim().ToLowerInvariant().Contains("android") == true;
    }

    internal static string LeadingGlyph(NodeInfo entry)
    {
        if (IsGateway(entry)) return "\uE704"; // NetworkTower (antenna radiowaves)
        var family = entry.DeviceFamily?.ToLowerInvariant();
        if (family is not null)
        {
            if (family.Contains("mac"))    return "\uE7F4"; // Laptop
            if (family.Contains("iphone")) return "\uE8EA"; // MobileDevice
            if (family.Contains("ipad"))   return "\uE8A1"; // Tablet
        }
        var platform = entry.Platform?.ToLowerInvariant();
        if (platform is not null)
        {
            if (platform.Contains("mac"))     return "\uE7F4"; // Laptop
            if (platform.Contains("ios"))     return "\uE8EA"; // MobileDevice
            if (platform.Contains("android")) return "\uE8EA"; // MobileDevice
        }
        return "\uE7EF"; // CPU (generic device)
    }

    // single-line accessibility / copy-to-clipboard string.
    internal static string SummaryText(NodeInfo entry)
    {
        if (IsGateway(entry))
        {
            var parts = new List<string> { $"{PrimaryName(entry)} · {RoleText(entry)}" };
            var ip       = NonEmpty(entry.RemoteIp);
            var platform = PlatformText(entry);
            if (ip       is not null) parts.Add($"host {ip}");
            if (platform is not null) parts.Add(platform);
            return string.Join(" · ", parts);
        }

        var ip2     = NonEmpty(entry.RemoteIp);
        var prefix  = ip2 is not null ? $"Node: {PrimaryName(entry)} ({ip2})" : $"Node: {PrimaryName(entry)}";
        var parts2  = new List<string> { prefix };
        var platform2 = PlatformText(entry);
        if (platform2 is not null) parts2.Add($"platform {platform2}");
        var versionLabels = VersionLabels(entry);
        if (versionLabels.Count > 0) parts2.Add(string.Join(" · ", versionLabels));
        parts2.Add($"status {RoleText(entry)}");
        return string.Join(" · ", parts2);
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    // null for empty/whitespace-only strings.
    private static string? NonEmpty(string? s)
    {
        var t = s?.Trim();
        return string.IsNullOrEmpty(t) ? null : t;
    }

    // strips trailing "(...digit...)" parenthetical.
    private static string CompactVersion(string raw)
    {
        var trimmed = raw.Trim();
        if (trimmed.Length == 0) return trimmed;
        var m = Regex.Match(trimmed, @"\s*\([^)]*\d[^)]*\)$");
        return m.Success ? trimmed[..m.Index] : trimmed;
    }

    // adds "v" prefix when starting with a digit.
    private static string ShortVersionLabel(string raw)
    {
        var compact = CompactVersion(raw);
        if (compact.Length == 0) return compact;
        if (compact.StartsWith('v') || compact.StartsWith('V')) return compact;
        if (char.IsDigit(compact[0])) return $"v{compact}";
        return compact;
    }

    // "core X" and/or "ui Y" labels.
    private static IReadOnlyList<string> VersionLabels(NodeInfo entry, bool compact = true)
    {
        var (core, ui) = ResolveVersions(entry);
        var labels = new List<string>(2);
        if (core is not null) labels.Add($"core {(compact ? CompactVersion(core) : ShortVersionLabel(core))}");
        if (ui   is not null) labels.Add($"ui {(compact   ? CompactVersion(ui)   : ShortVersionLabel(ui))}");
        return labels;
    }

    // prefers explicit core/ui; falls back to legacy split by headless test.
    private static (string? Core, string? Ui) ResolveVersions(NodeInfo entry)
    {
        var core = NonEmpty(entry.CoreVersion);
        var ui   = NonEmpty(entry.UiVersion);
        if (core is not null || ui is not null) return (core, ui);
        var legacy = NonEmpty(entry.Version);
        if (legacy is null) return (null, null);
        return IsHeadlessPlatform(entry) ? (legacy, null) : (null, legacy);
    }

    // darwin, linux, win32, windows.
    private static bool IsHeadlessPlatform(NodeInfo entry)
    {
        var raw = entry.Platform?.Trim().ToLowerInvariant() ?? "";
        return raw is "darwin" or "linux" or "win32" or "windows";
    }
}
