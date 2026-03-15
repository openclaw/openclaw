use anyhow::Result;
use regex::Regex;
use smallvec::SmallVec;

pub struct CommandGuard {
    allowed_prefixes: Vec<String>,
    blocked_patterns: Vec<Regex>,
}

impl CommandGuard {
    pub fn new(allowed_prefixes: &[String], blocked_patterns: &[String]) -> Result<Self> {
        let mut patterns = Vec::with_capacity(blocked_patterns.len());
        for pattern in blocked_patterns {
            patterns.push(Regex::new(pattern)?);
        }
        Ok(Self {
            allowed_prefixes: allowed_prefixes.to_vec(),
            blocked_patterns: patterns,
        })
    }

    pub fn score(&self, command: &str) -> (u8, SmallVec<[String; 4]>, SmallVec<[String; 4]>) {
        let mut score = 0_u8;
        let mut tags: SmallVec<[String; 4]> = SmallVec::new();
        let mut reasons: SmallVec<[String; 4]> = SmallVec::new();

        for re in &self.blocked_patterns {
            if re.is_match(command) {
                score = score.saturating_add(80);
                tags.push("blocked_command_pattern".to_owned());
                reasons.push(format!("command matched blocked pattern `{}`", re.as_str()));
            }
        }

        let normalized = command.trim().to_ascii_lowercase();
        if normalized.contains("sudo ") {
            score = score.saturating_add(18);
            tags.push("privilege_escalation".to_owned());
            reasons.push("command requests elevated privileges".to_owned());
        }
        if normalized.contains("curl ") && normalized.contains('|') {
            score = score.saturating_add(22);
            tags.push("remote_pipe_exec".to_owned());
            reasons.push("command pipes remote content to shell".to_owned());
        }
        if normalized.contains("wget ") && normalized.contains('|') {
            score = score.saturating_add(22);
            tags.push("remote_pipe_exec".to_owned());
            reasons.push("command pipes remote download to shell".to_owned());
        }

        if !self.allowed_prefixes.is_empty()
            && !self
                .allowed_prefixes
                .iter()
                .any(|prefix| command.trim_start().starts_with(prefix))
        {
            score = score.saturating_add(20);
            tags.push("not_in_allowlist".to_owned());
            reasons.push("command prefix not in allowlist".to_owned());
        }

        (score.min(100), tags, reasons)
    }
}

#[cfg(test)]
mod tests {
    use super::CommandGuard;

    #[test]
    fn blocks_known_destructive_patterns() {
        let guard = CommandGuard::new(
            &["git ".to_owned()],
            &[
                r"(?i)\brm\s+-rf\s+/".to_owned(),
                r"(?i)\bcurl\s+[^|]*\|\s*sh\b".to_owned(),
            ],
        )
        .expect("guard");

        let (score, tags, reasons) = guard.score("rm -rf /");
        assert!(score >= 80);
        assert!(tags.iter().any(|t| t == "blocked_command_pattern"));
        assert!(!reasons.is_empty());
    }

    #[test]
    fn flags_non_allowlisted_prefix() {
        let guard = CommandGuard::new(&["git ".to_owned(), "rg ".to_owned()], &[]).expect("guard");
        let (score, tags, _) = guard.score("python -m pip install something");
        assert!(score >= 20);
        assert!(tags.iter().any(|t| t == "not_in_allowlist"));
    }

    #[test]
    fn keeps_safe_allowlisted_command_low_risk() {
        let guard = CommandGuard::new(&["git ".to_owned()], &[]).expect("guard");
        let (score, tags, reasons) = guard.score("git status");
        assert_eq!(score, 0);
        assert!(tags.is_empty());
        assert!(reasons.is_empty());
    }
}
