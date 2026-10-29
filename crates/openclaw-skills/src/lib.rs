//! OpenClaw Skills & Agent Tools engine (`src/skills/` + `src/agents/tools/` rewrite).
//!
//! - Discovers and parses `SKILL.md` files from `skills/`, `custodian-skills/`, and `~/.openclaw/skills/`
//! - Embeds core custodian and utility skills so single-binary deployments always have skills available
//! - Provides `web_fetch` tool (including automatic weather lookup via `wttr.in`)
//! - Builds the `<available_skills>` prompt block matching `WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION`

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A parsed OpenClaw skill (`SKILL.md`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub emoji: Option<String>,
    pub homepage: Option<String>,
    pub source: String, // "bundled" | "custodian" | "workspace"
    pub file_path: String,
    pub instructions: String,
}

/// Registry holding discovered and bundled skills.
#[derive(Debug, Clone, Default)]
pub struct SkillRegistry {
    skills: HashMap<String, Skill>,
}

impl SkillRegistry {
    /// Discover skills from standard OpenClaw directories (`skills/`, `custodian-skills/`, `~/.openclaw/skills/`)
    /// plus built-in fallback skills for single-binary deployments.
    #[must_use]
    pub fn discover_default() -> Self {
        let mut reg = Self::default();
        reg.register_embedded_fallbacks();

        let mut roots: Vec<(PathBuf, &str)> = vec![
            (PathBuf::from("skills"), "bundled"),
            (PathBuf::from("../skills"), "bundled"),
            (PathBuf::from("/usr/local/share/openclaw/skills"), "bundled"),
            (PathBuf::from("custodian-skills"), "custodian"),
            (PathBuf::from("../custodian-skills"), "custodian"),
            (
                PathBuf::from("/usr/local/share/openclaw/custodian-skills"),
                "custodian",
            ),
        ];

        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            roots.push((
                Path::new(&home).join(".openclaw").join("skills"),
                "workspace",
            ));
        }

        for (root, source) in roots {
            if root.is_dir() {
                reg.load_dir(&root, source);
            }
        }

        reg
    }

    /// Load all `<root>/<skill_dir>/SKILL.md` files from a directory.
    pub fn load_dir(&mut self, root: &Path, source: &str) {
        let Ok(entries) = std::fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let skill_md = path.join("SKILL.md");
                if skill_md.is_file() {
                    if let Ok(raw) = std::fs::read_to_string(&skill_md) {
                        let fallback_name = path
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("unknown");
                        let skill =
                            parse_skill_md(&raw, fallback_name, source, &skill_md.display().to_string());
                        self.skills.insert(skill.name.clone(), skill);
                    }
                }
            }
        }
    }

    fn register_embedded_fallbacks(&mut self) {
        let builtins = [
            (
                "weather",
                "Current weather and forecasts with web_fetch (wttr.in) for locations, rain, temperature, and travel planning.",
                Some("☔"),
                "bundled",
                "Use `web_fetch` on `https://wttr.in/<Location>?format=j2` or `?format=3` to retrieve current temperature, feels-like, humidity, wind, and 3-day forecast.",
            ),
            (
                "diagnose-gateway",
                "Diagnose Gateway, config, secrets, channels, and port failures with read-only checks.",
                Some("🩺"),
                "custodian",
                "Run `openclaw doctor`, `openclaw gateway status`, and check `/api/status` and `/healthz` without mutating live config.",
            ),
            (
                "configure-channel",
                "Configure Telegram, Discord, and messaging channels with DM pairing and allowFrom policies.",
                Some("📡"),
                "custodian",
                "Configure `channels.telegram.botToken`, `dmPolicy` (pairing|allowlist|open), and approve senders with `openclaw pairing approve telegram <CODE>`.",
            ),
            (
                "add-model-provider",
                "Configure Anthropic, OpenAI, Ollama, or custom OpenAI-compatible model providers.",
                Some("🧠"),
                "custodian",
                "Add a provider entry under `[providers.<id>]` with `type`, `apiKey` (or `$ENV_VAR`), and `model`.",
            ),
            (
                "summarize",
                "Summarize web pages, documents, and long transcripts into concise key points.",
                Some("📝"),
                "bundled",
                "Fetch the target URL or read the provided text, extract key facts, and present a structured summary.",
            ),
            (
                "github",
                "Inspect GitHub repositories, issues, and pull requests.",
                Some("🐙"),
                "bundled",
                "Use GitHub REST endpoints or `gh` CLI to inspect issues, PRs, and commits.",
            ),
        ];

        for (name, desc, emoji, source, instructions) in builtins {
            self.skills.insert(
                name.to_owned(),
                Skill {
                    name: name.to_owned(),
                    description: desc.to_owned(),
                    emoji: emoji.map(str::to_owned),
                    homepage: None,
                    source: source.to_owned(),
                    file_path: format!("builtin:{name}/SKILL.md"),
                    instructions: instructions.to_owned(),
                },
            );
        }
    }

    /// Look up a skill by exact name.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&Skill> {
        self.skills.get(name)
    }

    /// List all skills sorted by name.
    #[must_use]
    pub fn list(&self) -> Vec<&Skill> {
        let mut out: Vec<&Skill> = self.skills.values().collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Total number of loaded skills.
    #[must_use]
    pub fn len(&self) -> usize {
        self.skills.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }

    /// Build the system prompt section listing available skills and matching active skill instructions.
    #[must_use]
    pub fn build_prompt_augmentation(&self, user_message: &str) -> String {
        let mut out = String::from("\n\n<available_skills>\n");
        for skill in self.list() {
            let emoji = skill.emoji.as_deref().unwrap_or("🔧");
            out.push_str(&format!(
                "- {} `{}` ({}): {}\n",
                emoji, skill.name, skill.source, skill.description
            ));
        }
        out.push_str("</available_skills>\n");

        // Auto-activate matching skill instructions when the user mentions the skill name
        let lower = user_message.to_lowercase();
        for skill in self.list() {
            if lower.contains(&skill.name.to_lowercase()) {
                out.push_str(&format!(
                    "\n<active_skill name=\"{}\">\n{}\n</active_skill>\n",
                    skill.name, skill.instructions
                ));
            }
        }
        out
    }
}

/// Parse a `SKILL.md` file with YAML frontmatter (`--- ... ---`).
#[must_use]
pub fn parse_skill_md(raw: &str, fallback_name: &str, source: &str, file_path: &str) -> Skill {
    let mut name = fallback_name.to_owned();
    let mut description = String::new();
    let mut homepage = None;
    let mut emoji = None;
    let mut instructions = raw.trim().to_owned();

    if let Some(after_open) = raw.strip_prefix("---") {
        if let Some((frontmatter, body)) = after_open.split_once("\n---") {
            instructions = body.trim().to_owned();
            for line in frontmatter.lines() {
                let trimmed = line.trim();
                if let Some(val) = trimmed.strip_prefix("name:") {
                    let v = val.trim().trim_matches('"').trim_matches('\'');
                    if !v.is_empty() {
                        name = v.to_owned();
                    }
                } else if let Some(val) = trimmed.strip_prefix("description:") {
                    let v = val.trim().trim_matches('"').trim_matches('\'');
                    if !v.is_empty() {
                        description = v.to_owned();
                    }
                } else if let Some(val) = trimmed.strip_prefix("homepage:") {
                    let v = val.trim().trim_matches('"').trim_matches('\'');
                    if !v.is_empty() {
                        homepage = Some(v.to_owned());
                    }
                } else if let Some(val) = trimmed.strip_prefix("\"emoji\":") {
                    let v = val
                        .trim()
                        .trim_end_matches(',')
                        .trim_matches('"')
                        .trim_matches('\'');
                    if !v.is_empty() {
                        emoji = Some(v.to_owned());
                    }
                }
            }
        }
    }

    if description.is_empty() {
        description = instructions
            .lines()
            .find(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
            .unwrap_or("OpenClaw skill")
            .trim()
            .chars()
            .take(140)
            .collect();
    }

    Skill {
        name,
        description,
        emoji,
        homepage,
        source: source.to_owned(),
        file_path: file_path.to_owned(),
        instructions,
    }
}

/// Built-in `web_fetch` tool (`src/agents/tools/web-fetch.ts` equivalent).
pub async fn web_fetch(url: &str, max_chars: usize) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("curl/8.5.0 OpenClaw-Rust/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(text.chars().take(max_chars).collect())
}

/// Execute the `weather` skill directly via `wttr.in`.
pub async fn fetch_weather(location: &str) -> Result<String, String> {
    let clean_loc = location.trim().replace(' ', "+");
    let url = format!("https://wttr.in/{clean_loc}?format=%l:+%c+%t+(feels+%f),+humidity+%h,+wind+%w,+precip+%p");
    web_fetch(&url, 500).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_skill_frontmatter_and_discovers_repo_skills() {
        let sample = "---\nname: weather\ndescription: \"Current weather and forecasts\"\nhomepage: https://wttr.in/:help\nmetadata:\n  {\n    \"openclaw\": {\n      \"emoji\": \"☔\"\n    }\n  }\n---\n# Weather\nUse web_fetch.";
        let parsed = parse_skill_md(sample, "fallback", "bundled", "skills/weather/SKILL.md");
        assert_eq!(parsed.name, "weather");
        assert_eq!(parsed.description, "Current weather and forecasts");
        assert_eq!(parsed.emoji.as_deref(), Some("☔"));
        assert!(parsed.instructions.contains("# Weather"));

        let reg = SkillRegistry::discover_default();
        assert!(reg.len() >= 6);
        assert!(reg.get("weather").is_some());
        assert!(reg.get("diagnose-gateway").is_some());
    }
}
