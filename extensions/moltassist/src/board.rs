// Board — ASCII status board for pit crew operations.

use colored::Colorize;
use serde_json::{json, Value};
use crate::task::{Task, TaskState};
use crate::runner::Runner;

/// Render an ASCII status board.
pub fn render(tasks: &[Task]) -> String {
    let mut lines = Vec::new();
    let total = tasks.len();
    let done = tasks.iter().filter(|t| t.state == TaskState::Done).count();
    let failed = tasks.iter().filter(|t| t.state == TaskState::Failed).count();
    let pct = if total > 0 { done * 100 / total } else { 0 };

    // Header
    lines.push(format!("{}", "═".repeat(60).dimmed()));
    lines.push(format!("  {}", "PIT CREW STATUS BOARD".bold()));
    lines.push(format!("{}", "═".repeat(60).dimmed()));

    // Progress bar
    let bar_len = 30;
    let filled = if total > 0 { bar_len * done / total } else { 0 };
    let bar: String = format!("[{}{}] {}% ({}/{})",
        "#".repeat(filled).green(),
        "-".repeat(bar_len - filled).dimmed(),
        pct, done, total,
    );
    lines.push(format!("\n  {}", bar));
    lines.push(String::new());

    // Group by state
    let states = [
        (TaskState::Running, "RUNNING", "▶"),
        (TaskState::Assigned, "ASSIGNED", "="),
        (TaskState::Verifying, "VERIFYING", "?"),
        (TaskState::Failed, "FAILED", "!"),
        (TaskState::Queued, "QUEUED", " "),
        (TaskState::Done, "DONE", "x"),
    ];

    for (state, label, icon) in &states {
        let state_tasks: Vec<&Task> = tasks.iter().filter(|t| t.state == *state).collect();
        if state_tasks.is_empty() { continue; }

        let header = format!("  {} ({})", label, state_tasks.len());
        lines.push(match state {
            TaskState::Done => header.green().to_string(),
            TaskState::Failed => header.red().to_string(),
            TaskState::Running => header.yellow().to_string(),
            _ => header.dimmed().to_string(),
        });

        for task in state_tasks.iter().take(10) {
            let desc: String = task.description.chars().take(45).collect();
            let agent = task.assigned_to.as_deref().unwrap_or("");
            let elapsed = if task.elapsed_secs > 0.0 {
                format!(" ({:.1}s)", task.elapsed_secs)
            } else {
                String::new()
            };
            let agent_str = if !agent.is_empty() { format!(" -> {}", agent) } else { String::new() };
            lines.push(format!("    [{}] {} {}{}{}", icon, task.id.dimmed(), desc, agent_str.cyan(), elapsed.dimmed()));
        }
        if state_tasks.len() > 10 {
            lines.push(format!("    ... +{} more", state_tasks.len() - 10));
        }
        lines.push(String::new());
    }

    // Projects summary
    let mut projects: std::collections::HashMap<&str, (usize, usize)> = std::collections::HashMap::new();
    for task in tasks {
        let p = if task.project.is_empty() { "unassigned" } else { &task.project };
        let entry = projects.entry(p).or_insert((0, 0));
        entry.1 += 1;
        if task.state == TaskState::Done { entry.0 += 1; }
    }

    lines.push(format!("  {}", "PROJECTS".bold()));
    let mut sorted_projects: Vec<_> = projects.iter().collect();
    sorted_projects.sort_by_key(|(_, (d, t))| std::cmp::Reverse(*d * 100 / t.max(&1)));
    for (name, (d, t)) in sorted_projects {
        let p = if *t > 0 { d * 100 / t } else { 0 };
        let bar = format!("{}/{} ({}%)", d, t, p);
        lines.push(format!("    {}: {}", name, if p == 100 { bar.green().to_string() } else { bar.to_string() }));
    }

    lines.push(String::new());
    lines.push(format!("{}", "═".repeat(60).dimmed()));
    lines.join("\n")
}

/// Serialize state to JSON.
pub fn to_state(tasks: &[Task], runner: &Runner) -> Value {
    let total = tasks.len();
    let done = tasks.iter().filter(|t| t.state == TaskState::Done).count();
    let failed = tasks.iter().filter(|t| t.state == TaskState::Failed).count();
    let stats = runner.stats();

    json!({
        "total": total,
        "done": done,
        "failed": failed,
        "completion": format!("{}%", if total > 0 { done * 100 / total } else { 0 }),
        "model": stats.model,
        "tasks_run": stats.tasks_run,
        "commands_run": stats.commands_run,
        "tasks": tasks.iter().map(|t| json!({
            "id": t.id,
            "description": t.description,
            "project": t.project,
            "state": format!("{:?}", t.state),
            "priority": format!("{:?}", t.priority),
            "assigned_to": t.assigned_to,
            "result": t.result,
            "error": t.error,
        })).collect::<Vec<_>>(),
    })
}
