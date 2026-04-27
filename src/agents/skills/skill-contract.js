export function createSyntheticSourceInfo(path, options) {
    return {
        path,
        source: options.source,
        scope: options.scope ?? "temporary",
        origin: options.origin ?? "top-level",
        baseDir: options.baseDir,
    };
}
function escapeXml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
/**
 * Keep this formatter's XML layout byte-for-byte aligned with the upstream
 * Agent Skills formatter so we can avoid importing the full pi-coding-agent
 * package root on the cold skills path. Visibility policy is applied upstream
 * before calling this helper.
 */
export function formatSkillsForPrompt(skills) {
    if (skills.length === 0) {
        return "";
    }
    const lines = [
        "\n\nThe following skills provide specialized instructions for specific tasks.",
        "Use the read tool to load a skill's file when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        "",
        "<available_skills>",
    ];
    for (const skill of skills) {
        lines.push("  <skill>");
        lines.push(`    <name>${escapeXml(skill.name)}</name>`);
        lines.push(`    <description>${escapeXml(skill.description)}</description>`);
        lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
        lines.push("  </skill>");
    }
    lines.push("</available_skills>");
    return lines.join("\n");
}
