use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineResult {
    ok: bool,
    exit_code: i32,
    stdout: String,
    stderr: String,
    json: Option<Value>,
    json_parse_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceArtifacts {
    workspace: String,
    run_id: String,
    manifest: Option<Value>,
    qa_report: Option<Value>,
    workflow_report: Option<Value>,
    report_markdown: Option<String>,
    files: Vec<String>,
    files_truncated: bool,
}

#[derive(Serialize)]
struct ArtifactResult {
    ok: bool,
    json: WorkspaceArtifacts,
}

fn repo_root() -> PathBuf {
    if let Ok(root) = std::env::var("CLAWMODELER_REPO_ROOT") {
        let path = PathBuf::from(root);
        if path.exists() {
            return path;
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or(manifest_dir)
}

fn sidecar_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(engine_bin) = std::env::var("CLAWMODELER_ENGINE_BIN") {
        candidates.push(PathBuf::from(engine_bin));
    }

    let binary_name = format!("clawmodeler-engine{}", std::env::consts::EXE_SUFFIX);

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(&binary_name));
        candidates.push(resource_dir.join("binaries").join(&binary_name));
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(&binary_name),
    );

    candidates
}

fn sidecar_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    sidecar_candidates(app)
        .into_iter()
        .find(|path| path.is_file())
}

fn run_engine_args(app: &tauri::AppHandle, args: Vec<String>) -> Result<EngineResult, String> {
    if args.iter().any(|arg| arg.contains('\0')) {
        return Err("ClawModeler arguments must not contain NUL bytes.".to_string());
    }

    let output = if let Some(engine_path) = sidecar_path(app) {
        Command::new(engine_path)
            .args(args)
            .env("PYTHONUNBUFFERED", "1")
            .output()
    } else {
        Command::new("python3")
            .arg("-m")
            .arg("clawmodeler_engine")
            .args(args)
            .current_dir(repo_root())
            .env("PYTHONUNBUFFERED", "1")
            .output()
    }
    .map_err(|error| format!("failed to start clawmodeler-engine: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let (json, json_parse_error) = match serde_json::from_str(stdout.trim()) {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(format!("{error}"))),
    };

    Ok(EngineResult {
        ok: output.status.success(),
        exit_code: output.status.code().unwrap_or(1),
        stdout,
        stderr,
        json,
        json_parse_error,
    })
}

#[tauri::command]
fn clawmodeler_doctor(app: tauri::AppHandle) -> Result<EngineResult, String> {
    run_engine_args(&app, vec!["doctor".into(), "--json".into()])
}

#[tauri::command]
fn clawmodeler_tools(app: tauri::AppHandle) -> Result<EngineResult, String> {
    run_engine_args(&app, vec!["tools".into(), "--json".into()])
}

#[tauri::command]
fn clawmodeler_run(app: tauri::AppHandle, args: Vec<String>) -> Result<EngineResult, String> {
    run_engine_args(&app, args)
}

#[tauri::command]
fn clawmodeler_workspace(workspace: String, run_id: String) -> Result<ArtifactResult, String> {
    let workspace_path = PathBuf::from(workspace.trim());
    if workspace_path.as_os_str().is_empty() {
        return Err("workspace is required".to_string());
    }

    let run_id = if run_id.trim().is_empty() {
        "demo".to_string()
    } else {
        run_id.trim().to_string()
    };
    let run_root = workspace_path.join("runs").join(&run_id);
    let reports_dir = workspace_path.join("reports");
    let (files, files_truncated) = list_files(&run_root);
    let artifacts = WorkspaceArtifacts {
        workspace: workspace_path.to_string_lossy().to_string(),
        run_id: run_id.clone(),
        manifest: read_json(run_root.join("manifest.json")),
        qa_report: read_json(run_root.join("qa_report.json")),
        workflow_report: read_json(run_root.join("workflow_report.json")),
        report_markdown: fs::read_to_string(reports_dir.join(format!("{run_id}_report.md"))).ok(),
        files,
        files_truncated,
    };

    Ok(ArtifactResult {
        ok: true,
        json: artifacts,
    })
}

fn read_json(path: PathBuf) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

const FILE_LIST_LIMIT: usize = 500;

fn list_files(root: &Path) -> (Vec<String>, bool) {
    let mut files = Vec::new();
    collect_files(root, &mut files);
    files.sort();
    let truncated = files.len() > FILE_LIST_LIMIT;
    files.truncate(FILE_LIST_LIMIT);
    (files, truncated)
}

fn collect_files(root: &Path, files: &mut Vec<String>) {
    if files.len() > FILE_LIST_LIMIT {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, files);
        } else if path.is_file() {
            files.push(path.to_string_lossy().to_string());
        }
    }
}

pub fn run() {
    if let Err(error) = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            clawmodeler_doctor,
            clawmodeler_tools,
            clawmodeler_run,
            clawmodeler_workspace
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("ClawModeler desktop failed to start: {error}");
        std::process::exit(1);
    }
}
