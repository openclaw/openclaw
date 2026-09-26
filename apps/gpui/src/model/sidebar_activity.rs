use std::collections::HashMap;

use markdown::{ParseOptions, mdast::Node};
use serde::Deserialize;
use serde_json::Value;

use super::sessions::SessionRow;

const BACKGROUND_LIMIT: usize = 6;
const THROTTLE_MS: u64 = 2_000;
const BUFFER_CHARS: usize = 16_384;
const INTERNAL_BEGIN: &str = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_END: &str = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObserverDigest {
    pub run_id: Option<String>,
    pub revision: u64,
    pub updated_at: u64,
    pub headline: String,
    pub health: String,
}

impl ObserverDigest {
    fn parse(value: &Value) -> Option<Self> {
        let digest: Self = serde_json::from_value(value.clone()).ok()?;
        (digest.revision > 0
            && !digest.headline.trim().is_empty()
            && digest.headline.chars().count() <= 120
            && matches!(
                digest.health.as_str(),
                "on-track"
                    | "grinding"
                    | "stuck"
                    | "waiting-on-user"
                    | "wrapping-up"
                    | "done"
                    | "failed"
            ))
        .then_some(digest)
    }

    fn newer_than(&self, other: &Self) -> bool {
        (self.revision, self.updated_at) > (other.revision, other.updated_at)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SidebarAttention {
    #[default]
    None,
    Question,
    Approval,
    Agent,
    Error,
}

/// A descendant request stays visible even when the parent has a lower-priority failure.
pub fn strongest_attention<'a>(
    rows: impl Iterator<Item = (&'a SessionRow, SidebarAttention)>,
) -> Option<(&'a SessionRow, SidebarAttention)> {
    let priority = |attention| match attention {
        SidebarAttention::Question | SidebarAttention::Approval => 3,
        SidebarAttention::Agent => 2,
        SidebarAttention::Error => 1,
        SidebarAttention::None => 0,
    };
    rows.reduce(|current, candidate| {
        if priority(candidate.1) > priority(current.1) {
            candidate
        } else {
            current
        }
    })
}

#[derive(Default)]
struct Narration {
    run_id: Option<String>,
    consumed: usize,
    depth: usize,
    delimiter_tail: String,
    visible: String,
    line: Option<String>,
    pending: Option<NarrationUpdate>,
    published_at: Option<u64>,
    observer: Option<ObserverDigest>,
}

enum NarrationUpdate {
    Text(String),
    Line(String),
}

impl NarrationUpdate {
    fn line(self) -> Option<String> {
        match self {
            Self::Text(text) => narration_line(&text),
            Self::Line(line) => Some(line),
        }
    }
}

impl Narration {
    fn publish(&mut self, update: NarrationUpdate, now: u64) {
        if self
            .published_at
            .is_none_or(|last| now.saturating_sub(last) >= THROTTLE_MS)
        {
            self.line = update.line();
            self.pending = None;
            self.published_at = Some(now);
        } else {
            self.pending = Some(update);
        }
    }

    fn update_text(&mut self, text: &str, delta: &str, replace: bool, now: u64) {
        let (fragment, reset, length) = if replace {
            let replacement = if text.is_empty() { delta } else { text };
            (replacement, true, replacement.encode_utf16().count())
        } else if !text.is_empty() {
            let length = text.encode_utf16().count();
            let appends = !delta.is_empty()
                && self.consumed > 0
                && length.checked_sub(delta.encode_utf16().count()) == Some(self.consumed);
            if !appends && length == self.consumed {
                return;
            }
            (if appends { delta } else { text }, !appends, length)
        } else if !delta.is_empty() && self.consumed > 0 {
            (delta, false, self.consumed + delta.encode_utf16().count())
        } else {
            // A bare delta can join halfway through hidden runtime context.
            return;
        };
        self.consumed = length;
        if reset {
            self.depth = 0;
            self.delimiter_tail.clear();
            self.visible.clear();
            self.pending = None;
        }
        if length == 0 {
            self.line = None;
            return;
        }
        let fragment = self.strip_internal_fragment(fragment);
        self.visible.push_str(&fragment);
        if self.visible.chars().count() > BUFFER_CHARS {
            self.visible = self
                .visible
                .chars()
                .rev()
                .take(BUFFER_CHARS)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
        }
        if self.visible.is_empty() {
            if reset {
                self.line = None;
            }
            return;
        }
        self.publish(NarrationUpdate::Text(self.visible.clone()), now);
    }

    fn strip_internal_fragment(&mut self, fragment: &str) -> String {
        let text = std::mem::take(&mut self.delimiter_tail) + fragment;
        let mut remaining = text.as_str();
        let mut visible = String::new();
        while !remaining.is_empty() {
            let begin = remaining.find(INTERNAL_BEGIN);
            let end = remaining.find(INTERNAL_END);
            let is_begin = begin.is_some_and(|begin| end.is_none_or(|end| begin < end));
            let Some(index) = (if is_begin { begin } else { end }) else {
                if self.depth == 0 {
                    visible.push_str(remaining);
                }
                break;
            };
            if is_begin {
                if self.depth == 0 {
                    visible.push_str(&remaining[..index]);
                }
                self.depth += 1;
                remaining = &remaining[index + INTERNAL_BEGIN.len()..];
            } else {
                // An unmatched close means the fragment began inside a block.
                self.depth = self.depth.saturating_sub(1);
                remaining = &remaining[index + INTERNAL_END.len()..];
            }
        }
        for length in (1..INTERNAL_END.len()).rev() {
            let Some(start) = text.len().checked_sub(length) else {
                continue;
            };
            let Some(suffix) = text.get(start..) else {
                continue;
            };
            if INTERNAL_BEGIN.starts_with(suffix) || INTERNAL_END.starts_with(suffix) {
                self.delimiter_tail = suffix.to_owned();
                if self.depth == 0 && visible.ends_with(suffix) {
                    visible.truncate(visible.len() - suffix.len());
                }
                break;
            }
        }
        visible
    }
}

#[derive(Default)]
pub struct SidebarActivity {
    desired: HashMap<String, Option<String>>,
    entries: HashMap<String, Narration>,
}

impl SidebarActivity {
    pub fn clear(&mut self) {
        self.desired.clear();
        self.entries.clear();
    }

    /// Returns the transport owner's desired scopes; the selected scope is shared.
    pub fn sync(
        &mut self,
        rows: &[&SessionRow],
        selected: Option<&str>,
        selected_agent: Option<&str>,
        enabled: bool,
    ) -> Vec<(Option<String>, String)> {
        if !enabled {
            self.clear();
            return Vec::new();
        }
        let mut running: Vec<_> = rows.iter().copied().filter(|row| row_active(row)).collect();
        running.sort_by(|a, b| {
            b.started_at
                .or(b.updated_at)
                .unwrap_or_default()
                .total_cmp(&a.started_at.or(a.updated_at).unwrap_or_default())
        });
        let mut background = 0;
        let mut desired = HashMap::new();
        let mut scopes = Vec::new();
        for row in running {
            let agent = row.agent().or(selected_agent).map(str::to_owned);
            let open = selected
                .is_some_and(|selected| session_matches(&row.key, selected, agent.as_deref()));
            if desired.contains_key(&row.key) || (!open && background >= BACKGROUND_LIMIT) {
                continue;
            }
            background += usize::from(!open);
            desired.insert(row.key.clone(), agent.clone());
            scopes.push((agent, row.key.clone()));
        }
        self.entries.retain(|key, _| {
            desired.get(key) == self.desired.get(key) && desired.contains_key(key)
        });
        self.desired = desired;
        scopes
    }

    pub fn handle_event(&mut self, name: &str, payload: &Value, now: u64) -> bool {
        if !matches!(name, "chat" | "agent" | "session.tool" | "session.observer") {
            return false;
        }
        let Some(key) = payload.get("sessionKey").and_then(Value::as_str) else {
            return false;
        };
        let agent = payload.get("agentId").and_then(Value::as_str);
        let Some(key) = self.desired.iter().find_map(|(wanted, wanted_agent)| {
            (wanted_agent
                .as_deref()
                .zip(agent)
                .is_none_or(|(a, b)| a == b)
                && session_matches(wanted, key, wanted_agent.as_deref()))
            .then(|| wanted.clone())
        }) else {
            return false;
        };
        let entry = self.entries.entry(key).or_default();
        let before = (entry.line.clone(), entry.observer.clone());
        if let Some(run) = payload
            .get("runId")
            .and_then(Value::as_str)
            .filter(|run| !run.is_empty())
        {
            if entry.run_id.as_deref().is_some_and(|old| old != run) {
                *entry = Narration::default();
            }
            entry.run_id = Some(run.to_owned());
        }
        if name == "session.observer" {
            if let Some(digest) = ObserverDigest::parse(payload)
                && digest
                    .run_id
                    .as_deref()
                    .is_some_and(|run| !run.trim().is_empty())
                && entry
                    .observer
                    .as_ref()
                    .is_none_or(|old| digest.newer_than(old))
            {
                *entry = Narration {
                    run_id: entry.run_id.clone(),
                    observer: Some(digest),
                    ..Default::default()
                };
            }
        } else if entry.observer.is_none() {
            if name == "chat" {
                let message = &payload["message"];
                if message
                    .get("role")
                    .and_then(Value::as_str)
                    .is_some_and(|role| role != "assistant")
                {
                    return false;
                }
                let text = message_text(message);
                let delta = payload
                    .get("deltaText")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let replace = payload.get("replace").and_then(Value::as_bool) == Some(true);
                entry.update_text(
                    if replace && !delta.is_empty() {
                        delta
                    } else {
                        &text
                    },
                    delta,
                    replace,
                    now,
                );
            } else {
                let data = &payload["data"];
                match payload.get("stream").and_then(Value::as_str) {
                    Some("tool") => {
                        if let Some(tool) = data
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            entry.publish(NarrationUpdate::Line(format!("Using {tool}")), now);
                        }
                    }
                    Some("assistant") => entry.update_text(
                        data.get("text").and_then(Value::as_str).unwrap_or_default(),
                        data.get("delta")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        data.get("replace").and_then(Value::as_bool) == Some(true),
                        now,
                    ),
                    _ => {}
                }
            }
        }
        before != (entry.line.clone(), entry.observer.clone())
    }

    pub fn tick(&mut self, now: u64) -> bool {
        let mut changed = false;
        for entry in self.entries.values_mut() {
            if entry
                .published_at
                .is_some_and(|last| now.saturating_sub(last) >= THROTTLE_MS)
                && let Some(update) = entry.pending.take()
            {
                let line = update.line();
                changed |= entry.line != line;
                entry.line = line;
                entry.published_at = Some(now);
            }
        }
        changed
    }

    pub fn subtitle(
        &self,
        row: &SessionRow,
        attention: SidebarAttention,
        show_preview: bool,
        live_activity: bool,
        now: u64,
    ) -> Option<String> {
        let running = row_active(row);
        if matches!(
            attention,
            SidebarAttention::Question | SidebarAttention::Error
        ) {
            return None;
        }
        let declared = row
            .agent_status
            .as_ref()
            .filter(|status| status.expires_at > now && !status.note.trim().is_empty());
        let attention = if attention == SidebarAttention::Approval {
            Some("Waiting for approval".to_owned())
        } else {
            declared
                .filter(|status| status.attention.is_some())
                .map(|status| status.note.clone())
        };
        let entry = self.entries.get(&row.key);
        let live = entry.and_then(|entry| entry.observer.as_ref());
        let projected = row.observer_digest.as_ref().and_then(ObserverDigest::parse);
        let matches = |digest: &&ObserverDigest| {
            !running
                || digest
                    .run_id
                    .as_ref()
                    .is_some_and(|run| row.active_run_ids.contains(run))
        };
        let live = live.filter(matches);
        let projected = projected.as_ref().filter(matches);
        let digest = match (live, projected) {
            (Some(live), Some(projected)) => Some(if projected.newer_than(live) {
                projected
            } else {
                live
            }),
            (live, projected) => live.or(projected),
        };
        let observer = digest.filter(|digest| {
            running
                || (matches!(digest.health.as_str(), "done" | "failed")
                    && row.last_read_at.unwrap_or_default() < digest.updated_at as f64)
        });
        if !show_preview {
            return attention.or_else(|| {
                observer
                    .filter(|digest| matches!(digest.health.as_str(), "stuck" | "waiting-on-user"))
                    .map(|digest| digest.headline.clone())
            });
        }
        attention
            .or_else(|| declared.map(|status| status.note.clone()))
            .or_else(|| observer.map(|digest| digest.headline.clone()))
            .or_else(|| {
                (live_activity && running)
                    .then(|| entry.and_then(|entry| entry.line.clone()))
                    .flatten()
            })
            .or_else(|| {
                (!running)
                    .then(|| {
                        row.last_message_preview
                            .as_deref()
                            .map(str::trim)
                            .filter(|preview| !preview.is_empty())
                            .map(str::to_owned)
                    })
                    .flatten()
            })
            .or_else(|| work_subtitle(row))
    }
}

fn row_active(row: &SessionRow) -> bool {
    !row.archived
        && row.has_active_run
        && row
            .status
            .as_deref()
            .is_none_or(|status| matches!(status, "running" | "queued"))
}

fn work_subtitle(row: &SessionRow) -> Option<String> {
    fn field<'a>(value: &'a Option<Value>, key: &str) -> Option<&'a str> {
        value
            .as_ref()?
            .get(key)?
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }
    let repository = field(&row.repository, "url").or_else(|| field(&row.worktree, "repoRoot"));
    let branch = field(&row.repository, "branch").or_else(|| field(&row.worktree, "branch"));
    let branch = branch.map(|branch| {
        if row.repository.is_none() {
            branch.strip_prefix("openclaw/").unwrap_or(branch)
        } else {
            branch
        }
    });
    let checkout = repository.map(|repository| {
        let name = repository
            .trim_end_matches(".git")
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(repository);
        match branch {
            Some(branch) => format!("{name} ⎇ {branch}"),
            None => name.to_owned(),
        }
    });
    let node = row
        .exec_node
        .as_deref()
        .map(str::trim)
        .filter(|node| !node.is_empty())
        .map(|node| {
            if node.len() >= 10 && node.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                format!("…{}", &node[node.len() - 4..])
            } else {
                node.to_owned()
            }
        });
    match (checkout, node) {
        (Some(checkout), Some(node)) => Some(format!("{checkout} · {node}")),
        (checkout, node) => checkout.or(node),
    }
}

pub fn session_matches(a: &str, b: &str, agent: Option<&str>) -> bool {
    a == b
        || agent.is_some_and(|agent| {
            (a == "global" && b == format!("agent:{agent}:global"))
                || (b == "global" && a == format!("agent:{agent}:global"))
        })
}

fn message_text(message: &Value) -> String {
    let content = &message["content"];
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    if let Some(parts) = content.as_array() {
        return parts
            .iter()
            .filter(|part| {
                matches!(
                    part["type"].as_str(),
                    Some("text" | "input_text" | "output_text")
                )
            })
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("");
    }
    message["text"].as_str().unwrap_or_default().to_owned()
}

fn narration_line(raw: &str) -> Option<String> {
    let mut text = raw.to_owned();
    let mut cursor = 0;
    while let Some(start) = text[cursor..].find("[[").map(|i| cursor + i) {
        let Some(end) = text[start + 2..].find("]]").map(|i| start + 2 + i + 2) else {
            break;
        };
        let directive = text[start + 2..end - 2].trim().to_ascii_lowercase();
        if directive == "audio_as_voice"
            || directive == "reply_to_current"
            || directive.starts_with("reply_to:")
        {
            text.replace_range(start..end, "");
            cursor = start;
        } else {
            cursor = end;
        }
    }
    let controls = ["NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP"];
    let mut trimmed = text.trim();
    loop {
        let before = trimmed;
        trimmed =
            trimmed.trim_end_matches(|c: char| c.is_whitespace() || matches!(c, '*' | '`' | '~'));
        for token in controls {
            if trimmed.ends_with(token) {
                trimmed = trimmed[..trimmed.len() - token.len()].trim_end();
            }
        }
        if before == trimmed {
            break;
        }
    }
    if controls
        .iter()
        .any(|token| token.starts_with(&trimmed.to_ascii_uppercase()))
    {
        return None;
    }
    if trimmed.starts_with("HEARTBEAT_OK") || trimmed.ends_with("HEARTBEAT_OK") {
        trimmed = trimmed
            .trim_start_matches("HEARTBEAT_OK")
            .trim_end_matches("HEARTBEAT_OK")
            .trim();
        if trimmed.chars().count() <= 300 {
            return None;
        }
    }
    let root = markdown::to_mdast(trimmed, &ParseOptions::gfm()).ok()?;
    let paragraph = root
        .children()?
        .iter()
        .rev()
        .map(plain_text)
        .find(|s| !s.trim().is_empty())?;
    let paragraph = paragraph.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut start = 0;
    let mut newest = paragraph.as_str();
    for (index, character) in paragraph.char_indices() {
        let end = index + character.len_utf8();
        if matches!(character, '.' | '!' | '?' | '…')
            && paragraph[end..]
                .chars()
                .next()
                .is_none_or(char::is_whitespace)
        {
            if !paragraph[start..end].trim().is_empty() {
                newest = paragraph[start..end].trim();
            }
            start = end;
        }
    }
    if !paragraph[start..].trim().is_empty() {
        newest = paragraph[start..].trim();
    }
    if newest.is_empty() {
        None
    } else if newest.chars().count() > 120 {
        Some(format!("{}…", newest.chars().take(119).collect::<String>()))
    } else {
        Some(newest.to_owned())
    }
}

fn plain_text(node: &Node) -> String {
    match node {
        Node::Code(_) | Node::Definition(_) => String::new(),
        Node::Text(text) => text.value.clone(),
        Node::InlineCode(code) => code.value.clone(),
        Node::Image(image) => image.alt.clone(),
        Node::ImageReference(image) => image.alt.clone(),
        Node::Break(_) => " ".into(),
        _ => node
            .children()
            .map(|nodes| nodes.iter().map(plain_text).collect::<Vec<_>>().join(""))
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests;
