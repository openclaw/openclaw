// MoltAssist — Autonomous task execution for OpenClaw
// F1 pit crew for your codebase.
// MIT License · AnnulusLabs LLC 2026

mod gene;
mod task;
mod dispatch;
mod manifest;
mod board;
mod runner;
mod verify;

use clap::{Parser, Subcommand};
use colored::Colorize;

#[derive(Parser)]
#[command(name = "moltassist")]
#[command(about = "Autonomous task execution for OpenClaw")]
#[command(version = "0.1.0")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Execute a markdown checklist
    Run {
        /// Path to markdown checklist
        checklist: String,
        /// Ollama model name (overrides tier)
        #[arg(long)]
        model: Option<String>,
        /// Model tier: heavy, medium, light, tiny
        #[arg(long, default_value = "medium")]
        tier: String,
        /// Run shell commands automatically
        #[arg(long)]
        auto_execute: bool,
        /// Output state file
        #[arg(short, long)]
        output: Option<String>,
    },
    /// Plan tasks without executing
    Plan {
        checklist: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long, default_value = "medium")]
        tier: String,
    },
    /// Show status from saved state
    Status {
        state: String,
    },
    /// List available models
    Models,
}

fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Run { checklist, model, tier, auto_execute, output } => {
            cmd_run(&checklist, model.as_deref(), &tier, auto_execute, output.as_deref());
        }
        Commands::Plan { checklist, model, tier } => {
            cmd_plan(&checklist, model.as_deref(), &tier);
        }
        Commands::Status { state } => {
            cmd_status(&state);
        }
        Commands::Models => {
            cmd_models();
        }
    }
}

fn cmd_run(path: &str, model: Option<&str>, tier: &str, auto_execute: bool, output: Option<&str>) {
    let model_name = model
        .map(String::from)
        .unwrap_or_else(|| runner::tier_to_model(tier).to_string());
    let mut runner = runner::Runner::new(&model_name, auto_execute);

    println!("{}", "MoltAssist v0.1.0".green().bold());
    println!("Model:        {}", model_name.cyan());
    println!("Auto-execute: {}", if auto_execute { "ON".red().bold().to_string() } else { "OFF".dimmed().to_string() });
    println!("Checklist:    {}", path.yellow());
    println!();

    // Load
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => { eprintln!("{} {}: {}", "Error:".red(), path, e); std::process::exit(1); }
    };
    let mut tasks = manifest::parse_markdown(&content);
    println!("Parsed {} tasks from {} projects", tasks.len(), manifest::count_projects(&tasks));

    // Triage
    dispatch::triage(&mut tasks);
    let assignments = dispatch::assign(&mut tasks);
    println!("Assigned {} tasks to {} agent types\n", assignments.len(), dispatch::unique_agents(&assignments));

    // Execute
    for (task_idx, _agent_type) in &assignments {
        let task = &mut tasks[*task_idx];
        if task.state != task::TaskState::Assigned { continue; }
        task.state = task::TaskState::Running;
        task.started_at = Some(std::time::Instant::now());

        let desc_short: String = task.description.chars().take(50).collect();
        println!("  {} {} {}", "▶".green(), task.id.dimmed(), desc_short);

        match runner.execute(task) {
            Some(result) => {
                task.state = task::TaskState::Done;
                task.result = Some(result);
            }
            None => {
                task.state = task::TaskState::Failed;
                task.error = Some("executor returned None".into());
            }
        }
    }

    // Report
    println!("\n{}", board::render(&tasks));

    // Save state
    let default_out = path.replace(".md", "_state.json");
    let out_path = output.unwrap_or(&default_out);
    if let Ok(json) = serde_json::to_string_pretty(&board::to_state(&tasks, &runner)) {
        let _ = std::fs::write(out_path, json);
        println!("State saved: {}", out_path.dimmed());
    }

    let stats = runner.stats();
    println!("Tasks: {}, Commands: {}", stats.tasks_run, stats.commands_run);
}

fn cmd_plan(path: &str, model: Option<&str>, tier: &str) {
    let model_name = model
        .map(String::from)
        .unwrap_or_else(|| runner::tier_to_model(tier).to_string());
    let runner = runner::Runner::new(&model_name, false);

    println!("{}", "MoltAssist v0.1.0 — Plan Mode".green().bold());
    println!("Model: {}\n", model_name.cyan());

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => { eprintln!("{} {}: {}", "Error:".red(), path, e); std::process::exit(1); }
    };
    let mut tasks = manifest::parse_markdown(&content);
    dispatch::triage(&mut tasks);
    let assignments = dispatch::assign(&mut tasks);

    for (task_idx, agent_type) in assignments.iter().take(20) {
        let task = &tasks[*task_idx];
        println!("  {} [{:8}] -> {:8} | {}",
            task.id.dimmed(),
            format!("{:?}", task.priority).yellow(),
            format!("{:?}", agent_type).cyan(),
            task.description.chars().take(55).collect::<String>(),
        );
        if let Some(plan) = runner.plan(task) {
            for line in plan.lines().take(4) {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    println!("    {}", trimmed.dimmed());
                }
            }
        }
        println!();
    }
    if assignments.len() > 20 {
        println!("  ... +{} more tasks", assignments.len() - 20);
    }
}

fn cmd_status(path: &str) {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => { eprintln!("{} {}: {}", "Error:".red(), path, e); std::process::exit(1); }
    };
    let state: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => { eprintln!("{} invalid JSON: {}", "Error:".red(), e); std::process::exit(1); }
    };

    println!("Completion: {}", state["completion"].as_str().unwrap_or("?").green().bold());
    println!("Total:      {}", state["total"]);
    println!("Done:       {}", state["done"]);
    println!("Failed:     {}", state["failed"]);
}

fn cmd_models() {
    println!("{}", "MoltAssist Model Tiers:".bold());
    for (tier, model) in runner::MODEL_TIERS {
        println!("  {:8} -> {}", tier.cyan(), model);
    }

    println!("\n{}:", format!("Ollama ({})", runner::OLLAMA_URL).bold());

    match runner::list_models() {
        Ok(models) => {
            let (mut abliterated, mut standard): (Vec<_>, Vec<_>) = models.into_iter()
                .partition(|(name, _)| {
                    let n = name.to_lowercase();
                    n.contains("dolphin") || n.contains("uncensored") || n.contains("hermes")
                        || n.contains("samantha") || n.contains("wizard-vicuna")
                });

            if !abliterated.is_empty() {
                println!("\n  {} ({}):", "Abliterated".red().bold(), abliterated.len());
                abliterated.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
                for (name, gb) in &abliterated {
                    println!("  {} {:40} {:6.1} GB", "*".red(), name, gb);
                }
            }
            if !standard.is_empty() {
                println!("\n  {} ({}):", "Standard".dimmed(), standard.len());
                standard.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
                for (name, gb) in &standard {
                    println!("    {:40} {:6.1} GB", name, gb);
                }
            }
        }
        Err(e) => {
            println!("  {} {}", "Not running:".red(), e);
            println!("  Start with: ollama serve");
        }
    }
}
