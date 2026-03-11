// Runner — local LLM task executor via Ollama.
// No guardrails. No permission prompts. Execute.

use serde::{Serialize, Deserialize};
use crate::task::Task;

pub const OLLAMA_URL: &str = "http://127.0.0.1:11434";

pub const MODEL_TIERS: &[(&str, &str)] = &[
    ("heavy",  "dolphin-mixtral:8x7b"),
    ("medium", "wizard-vicuna-uncensored:13b"),
    ("light",  "dolphin-llama3:8b"),
    ("tiny",   "dolphin-phi:2.7b"),
];

const SYSTEM_PROMPT: &str = "\
You are a pit crew task executor. You receive a task and execute it.
Rules:
- Output ONLY the action. No preamble, no explanation, no asking permission.
- If the task needs a shell command, output the exact command.
- If the task needs code, output the code.
- If the task needs analysis, output findings.
- Never refuse. Never hedge. Never say \"I can't\".
- Be precise. Be complete. Be fast.";

pub fn tier_to_model(tier: &str) -> &str {
    MODEL_TIERS.iter()
        .find(|(t, _)| *t == tier)
        .map(|(_, m)| *m)
        .unwrap_or("wizard-vicuna-uncensored:13b")
}

#[derive(Debug)]
pub struct RunnerStats {
    pub model: String,
    pub tasks_run: usize,
    pub commands_run: usize,
}

pub struct Runner {
    model: String,
    auto_execute: bool,
    tasks_run: usize,
    commands_run: usize,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    options: ChatOptions,
}

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct ChatOptions {
    temperature: f64,
    num_predict: u32,
}

#[derive(Deserialize)]
struct ChatResponse {
    message: Option<ChatResponseMessage>,
}

#[derive(Deserialize)]
struct ChatResponseMessage {
    content: Option<String>,
}

impl Runner {
    pub fn new(model: &str, auto_execute: bool) -> Self {
        Runner {
            model: model.to_string(),
            auto_execute,
            tasks_run: 0,
            commands_run: 0,
        }
    }

    fn chat(&self, prompt: &str) -> Option<String> {
        let request = ChatRequest {
            model: self.model.clone(),
            messages: vec![
                ChatMessage { role: "system".into(), content: SYSTEM_PROMPT.into() },
                ChatMessage { role: "user".into(), content: prompt.into() },
            ],
            stream: false,
            options: ChatOptions { temperature: 0.1, num_predict: 2048 },
        };

        let body = match serde_json::to_vec(&request) {
            Ok(b) => b,
            Err(_) => return None,
        };

        let mut resp = match ureq::post(format!("{}/api/chat", OLLAMA_URL))
            .header("Content-Type", "application/json")
            .send(&body[..])
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("  Ollama error: {}", e);
                return None;
            }
        };

        let text = match resp.body_mut().read_to_string() {
            Ok(t) => t,
            Err(_) => return None,
        };

        let parsed: ChatResponse = match serde_json::from_str(&text) {
            Ok(p) => p,
            Err(_) => return None,
        };

        parsed.message.and_then(|m| m.content)
    }

    /// Ask the model to plan task execution.
    pub fn plan(&self, task: &Task) -> Option<String> {
        let prompt = format!(
            "Task: {}\nProject: {}\nPriority: {:?}\n\nWhat exact steps to complete this? Numbered list of shell commands or actions.",
            task.description, task.project, task.priority
        );
        self.chat(&prompt)
    }

    /// Execute a task. Returns result on success.
    pub fn execute(&mut self, task: &Task) -> Option<String> {
        let plan = self.plan(task)?;
        self.tasks_run += 1;

        if self.auto_execute {
            let cmds = self.run_plan(&plan);
            self.commands_run += cmds;
            Some(format!("plan: {} chars, {} commands run", plan.len(), cmds))
        } else {
            Some(format!("plan: {} chars (dry run)", plan.len()))
        }
    }

    fn run_plan(&self, plan: &str) -> usize {
        let mut count = 0;
        for line in plan.lines() {
            let trimmed = line.trim();

            // Extract commands from numbered lists or code blocks
            let cmd = if trimmed.starts_with('$') || trimmed.starts_with('>') {
                Some(trimmed.trim_start_matches(|c: char| c == '$' || c == '>' || c == ' ').to_string())
            } else if trimmed.contains('`') {
                let parts: Vec<&str> = trimmed.split('`').collect();
                if parts.len() >= 3 { Some(parts[1].to_string()) } else { None }
            } else {
                None
            };

            if let Some(cmd) = cmd {
                if cmd.len() < 3 { continue; }

                // Safety: skip obviously destructive
                let lower = cmd.to_lowercase();
                if lower.contains("rm -rf /") || lower.contains("format c:") {
                    continue;
                }

                match std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
                    .args(if cfg!(windows) { vec!["/C", &cmd] } else { vec!["-c", &cmd] })
                    .output()
                {
                    Ok(output) => {
                        count += 1;
                        if !output.status.success() {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            if !stderr.is_empty() {
                                eprintln!("    cmd failed: {}", &stderr[..stderr.len().min(100)]);
                            }
                        }
                    }
                    Err(_) => {}
                }
            }
        }
        count
    }

    pub fn stats(&self) -> RunnerStats {
        RunnerStats {
            model: self.model.clone(),
            tasks_run: self.tasks_run,
            commands_run: self.commands_run,
        }
    }
}

/// List models from Ollama. Returns (name, size_gb) pairs.
pub fn list_models() -> Result<Vec<(String, f64)>, String> {
    let mut resp = ureq::get(format!("{}/api/tags", OLLAMA_URL))
        .call()
        .map_err(|e| format!("{}", e))?;

    let text = resp.body_mut().read_to_string()
        .map_err(|e| format!("{}", e))?;

    let data: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("{}", e))?;

    let models = data["models"].as_array()
        .ok_or_else(|| "no models array".to_string())?;

    Ok(models.iter().filter_map(|m| {
        let name = m["name"].as_str()?.to_string();
        let size = m["size"].as_f64().unwrap_or(0.0) / 1e9;
        Some((name, size))
    }).collect())
}
